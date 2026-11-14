import { LlmError } from "./errors.js";
import { GeminiGroundedClient } from "./gemini.js";
import { sseData } from "./sse.js";
import type { ChatMessage, CompleteOptions, LlmClient, LlmReply } from "./types.js";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Minimal client for any OpenAI-compatible `/chat/completions` endpoint. */
export class OpenAICompatibleClient implements LlmClient {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  // `fast` is not sent: reasoning controls differ across OpenAI-compatible providers and unknown
  // parameters are rejected by some of them.
  async complete(messages: ChatMessage[], { onDelta }: CompleteOptions = {}): Promise<LlmReply> {
    // Accept both a base URL (`…/v1`) and the full endpoint (`…/v1/chat/completions`).
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model: this.config.model, messages, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new LlmError(`LLM request failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
    }
    let content = "";
    for await (const data of sseData(res.body)) {
      if (data.trim() === "[DONE]") break;
      const chunk = JSON.parse(data) as {
        choices?: { delta?: { content?: string } }[];
        error?: { message?: string };
      };
      if (chunk.error) throw new LlmError(`LLM stream failed: ${chunk.error.message ?? data.slice(0, 300)}`);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        onDelta?.(delta);
      }
    }
    if (!content.trim()) throw new LlmError("LLM returned an empty response");
    return { content: content.trim(), sources: [] };
  }
}

/** Used when configuration is incomplete: the UI still works for reading notes and editing intent. */
export class UnconfiguredClient implements LlmClient {
  constructor(
    private readonly missing: string[],
    private readonly where = "in .env",
  ) {}

  async complete(): Promise<LlmReply> {
    throw new LlmError(`LLM is not configured; set ${this.missing.join(", ")} ${this.where}`);
  }
}

/**
 * Gemini models get Google Search grounding (the model decides when to search) through the
 * gateway's native Gemini endpoint; everything else uses plain chat completions.
 * `WEB_SEARCH=off` disables grounding; `GEMINI_BASE_URL` overrides the native endpoint base.
 */
export function clientFromEnv(env: Record<string, string | undefined>): {
  client: LlmClient;
  model: string | null;
  webSearch: boolean;
  /** Host the model requests go to (shown in the context inspector); null when unconfigured. */
  endpoint: string | null;
} {
  const required = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) return { client: new UnconfiguredClient(missing), model: null, webSearch: false, endpoint: null };
  const model = env.OPENAI_MODEL!.trim();
  const baseUrl = env.OPENAI_BASE_URL!.trim();
  const apiKey = env.OPENAI_API_KEY!.trim();

  const isGemini = /(^|\/)gemini/i.test(model);
  if (isGemini && env.WEB_SEARCH?.trim().toLowerCase() !== "off") {
    const nativeBase = env.GEMINI_BASE_URL?.trim() || `${new URL(baseUrl).origin}/v1beta`;
    return {
      client: new GeminiGroundedClient({ baseUrl: nativeBase, apiKey, model }),
      model,
      webSearch: true,
      endpoint: new URL(nativeBase).host,
    };
  }
  return {
    client: new OpenAICompatibleClient({ baseUrl, apiKey, model }),
    model,
    webSearch: false,
    endpoint: new URL(baseUrl).host,
  };
}
