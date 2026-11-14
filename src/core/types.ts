/** Where a thread is pinned in the note. `null` anchor = a note-level thread. */
export interface Anchor {
  /** Index of the top-level Markdown block (paragraph, heading, code block, list...). */
  blockIndex: number;
  /** Exact passage the user selected; the whole block's text when asking about a paragraph. */
  quote: string;
}

export type Role = "user" | "assistant";

/** A web page the AI used for its answer (web search grounding). */
export interface Source {
  title: string;
  url: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  /** Present on assistant messages that used web search; `content` links `[n]` to `sources[n-1]`. */
  sources?: Source[];
  /** Vault notes (paths) given to the AI as context for this answer. */
  related?: string[];
  /** Quick action the user clicked to send this message (user messages only). */
  action?: string;
}

export interface Thread {
  id: string;
  anchor: Anchor | null;
  createdAt: string;
  messages: Message[];
  /** Framework this thread explains the idea through (concept lens), e.g. "C.S. Holling's Adaptive Cycle". */
  lens?: string;
}

/** Contents of a note's sidecar, `.yorum/<note path>.json`. */
export interface Sidecar {
  version: 1;
  /** Per-note system prompt in the user's words: what the note is for, how the AI should behave. */
  intent: string;
  threads: Thread[];
  updatedAt: string | null;
}

export interface Block {
  index: number;
  type: string;
  /** Raw Markdown source of the block. */
  raw: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmReply {
  content: string;
  sources: Source[];
}

/** Receives answer text as it is generated (streaming). */
export type DeltaHandler = (text: string) => void;

export interface CompleteOptions {
  /** Gets the answer text as it streams in. */
  onDelta?: DeltaHandler;
  /**
   * Trade reasoning depth for speed (Gemini: thinkingLevel "low", ~2.5× faster in measurement).
   * Used where a plain explanation is wanted, not where reasoning quality is the point.
   */
  fast?: boolean;
}

export interface LlmClient {
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<LlmReply>;
}
