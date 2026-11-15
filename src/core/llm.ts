import { LlmError } from "./errors.js";
import { GeminiGroundedClient } from "./gemini.js";
import { sseData } from "./sse.js";
import type { ChatMessage, CompleteOptions, LlmClient, LlmReply } from "./types.js";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  /** Empty for servers without auth (local models): no Authorization header is sent. */
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
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
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
  constructor(private readonly missing: string[]) {}

  async complete(): Promise<LlmReply> {
    throw new LlmError(`LLM is not configured; set ${this.missing.join(", ")} in Settings → Yorum`);
  }
}

/**
 * Gemini models with `webSearch` get Google Search grounding (the model decides when to search)
 * through the gateway's native Gemini endpoint (`<origin>/v1beta`); everything else uses plain
 * chat completions.
 */
export function createClient({ baseUrl, apiKey, model, webSearch }: OpenAICompatibleConfig & { webSearch: boolean }): {
  client: LlmClient;
  webSearch: boolean;
  /** Host the model requests go to (shown in the context inspector). */
  endpoint: string;
} {
  if (webSearch && /(^|\/)gemini/i.test(model)) {
    const nativeBase = `${new URL(baseUrl).origin}/v1beta`;
    return {
      client: new GeminiGroundedClient({ baseUrl: nativeBase, apiKey, model }),
      webSearch: true,
      endpoint: new URL(nativeBase).host,
    };
  }
  return { client: new OpenAICompatibleClient({ baseUrl, apiKey, model }), webSearch: false, endpoint: new URL(baseUrl).host };
}
