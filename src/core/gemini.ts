import { LlmError } from "./errors.js";
import { sseData } from "./sse.js";
import type { ChatMessage, CompleteOptions, LlmClient, LlmReply, Source } from "./types.js";

export interface GeminiConfig {
  /** Native Gemini API base, e.g. `https://api.orcarouter.ai/v1beta`. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface GroundingChunk {
  web?: { uri?: string; title?: string; domain?: string };
}

interface GroundingSupport {
  /** Byte offsets into the UTF-8 encoded answer text. */
  segment?: { startIndex?: number; endIndex?: number };
  groundingChunkIndices?: number[];
}

export interface GroundingMetadata {
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
}

/** Turns a URL into its final destination; returns the input when it cannot. */
export type UrlResolver = (url: string) => Promise<string>;

const REDIRECT_TIMEOUT_MS = 4000;

/** Google grounding links are redirects; follow one hop to show the real page URL. */
export const resolveRedirect: UrlResolver = async (url) => {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
    });
    const location = res.headers.get("location");
    return location ? new URL(location, url).toString() : url;
  } catch {
    return url;
  }
};

/**
 * Gemini via its native `generateContent` API with the Google Search tool enabled.
 * The model decides on its own whether a question needs a search.
 */
export class GeminiGroundedClient implements LlmClient {
  constructor(
    private readonly config: GeminiConfig,
    private readonly resolveUrl: UrlResolver = resolveRedirect,
  ) {}

  async complete(messages: ChatMessage[], { onDelta, fast = false }: CompleteOptions = {}): Promise<LlmReply> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const body = {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      tools: [{ googleSearch: {} }],
      ...(fast ? { generationConfig: { thinkingConfig: { thinkingLevel: "low" } } } : {}),
    };
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/models/${this.config.model}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      throw new LlmError(`LLM request failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
    }

    // Text streams in chunk by chunk; grounding metadata arrives with the last chunk.
    let text = "";
    let metadata: GroundingMetadata | undefined;
    let finishReason: string | undefined;
    for await (const data of sseData(res.body)) {
      const chunk = JSON.parse(data) as {
        candidates?: {
          content?: { parts?: { text?: string; thought?: boolean }[] };
          finishReason?: string;
          groundingMetadata?: GroundingMetadata;
        }[];
        error?: { message?: string };
      };
      if (chunk.error) throw new LlmError(`LLM stream failed: ${chunk.error.message ?? data.slice(0, 300)}`);
      const candidate = chunk.candidates?.[0];
      const delta = (candidate?.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text)
        .join("");
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
      if (candidate?.groundingMetadata) metadata = candidate.groundingMetadata;
      if (candidate?.finishReason) finishReason = candidate.finishReason;
    }
    if (!text.trim()) {
      throw new LlmError(`LLM returned an empty response (finishReason: ${finishReason ?? "unknown"})`);
    }
    return groundedReply(text, metadata, this.resolveUrl);
  }
}

/**
 * Number the sources in order of first citation, resolve their URLs, and insert Markdown
 * citation links (`[\[1\]](url)`, brackets escaped so Obsidian doesn't read `[[1]]` as a wiki link)
 * where the grounded segments end. Markers that would land
 * inside a fenced block (a diagram or code) are dropped; the source stays listed.
 */
export async function groundedReply(
  text: string,
  metadata: GroundingMetadata | undefined,
  resolveUrl: UrlResolver,
): Promise<LlmReply> {
  const chunks = metadata?.groundingChunks ?? [];
  const usable = (i: number) => typeof chunks[i]?.web?.uri === "string";
  const supports = (metadata?.groundingSupports ?? [])
    .map((s) => ({ end: s.segment?.endIndex, chunks: (s.groundingChunkIndices ?? []).filter(usable) }))
    .filter((s): s is { end: number; chunks: number[] } => Number.isInteger(s.end) && s.chunks.length > 0)
    .sort((a, b) => a.end - b.end);

  // Cited chunks in order of first citation; uncited chunks are still sources the model read.
  const order: number[] = [];
  for (const s of supports) for (const c of s.chunks) if (!order.includes(c)) order.push(c);
  chunks.forEach((_, i) => {
    if (usable(i) && !order.includes(i)) order.push(i);
  });
  if (order.length === 0) return { content: text.trim(), sources: [] };

  const sources: Source[] = await Promise.all(
    order.map(async (i) => {
      const web = chunks[i].web!;
      return { title: web.title || web.domain || "source", url: await resolveUrl(web.uri!) };
    }),
  );
  const numberOf = new Map(order.map((chunk, n) => [chunk, n + 1]));

  // Gemini's segment offsets count UTF-8 bytes (TextEncoder/TextDecoder: works in Node and Obsidian).
  const bytes = new TextEncoder().encode(text);
  const decode = (from: number, to?: number) => new TextDecoder().decode(bytes.subarray(from, to));
  let out = "";
  let cursor = 0;
  for (const s of supports) {
    const end = Math.min(s.end, bytes.length);
    if (end < cursor) continue;
    out += decode(cursor, end);
    cursor = end;
    // A marker inside an open fence (diagram or code) would break it, and so would one appended to
    // the fence line itself: a closing ``` followed by text no longer closes the block.
    if ((out.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 === 1) continue;
    if (/^\s*(```|~~~)[^\n]*$/.test(out.slice(out.lastIndexOf("\n") + 1))) continue;
    const numbers = [...new Set(s.chunks.map((c) => numberOf.get(c)!))].sort((a, b) => a - b);
    out += numbers.map((n) => `[\\[${n}\\]](${sources[n - 1].url})`).join("");
  }
  out += decode(cursor);
  return { content: out.trim(), sources };
}
