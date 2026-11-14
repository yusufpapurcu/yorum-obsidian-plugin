import type { Source } from "./types.js";

/**
 * Bring an AI comment into your own note, on your terms: Markdown that Obsidian renders natively —
 * a foldable callout with the passage, the question, the answer, its sources, and its visual.
 * Shared by the web UI (served as /core/callout.js) and the Obsidian plugin.
 */

const SVG_FENCE = /```svg\s*\n([\s\S]*?)```/g;
const LEGACY_CITATION = /\[\[(\d+)\]\]\((https?:\/\/[^)\s]+)\)/g;

/**
 * Citation links used to be written `[[1]](url)`, which Obsidian reads as a wiki link to "1"
 * followed by a bare URL. Rewrite them to `[\[1\]](url)` (rendered as a link labelled [1]).
 */
export function escapeCitations(markdown: string): string {
  return markdown.replace(LEGACY_CITATION, "[\\[$1\\]]($2)");
}

export interface CalloutInput {
  question: string;
  answer: string;
  quote?: string | null;
  lens?: string | null;
  sources?: Source[];
  date?: Date;
}

export function toObsidianCallout({
  question,
  answer,
  quote = null,
  lens = null,
  sources = [],
  date = new Date(),
}: CalloutInput): string {
  const day = date.toISOString().slice(0, 10);
  const title = `yorum · ${lens ? `${lens} · ` : ""}${day}`;
  // Obsidian has no ```svg renderer, but renders inline <svg>: unwrap sketches so they show up.
  // Every step is visible in the export — the final picture.
  const body = escapeCitations(answer).replace(SVG_FENCE, (_, svg: string) => svg.trim().replace(/\n\s*\n/g, "\n"));
  const lines = [
    `[!ai]+ ${title}`,
    ...(quote ? [`*On:* "${quote.replace(/\s+/g, " ").trim()}"`, ""] : []),
    `**${question.trim()}**`,
    "",
    ...body.split("\n"),
    ...(sources.length ? ["", "Sources:", ...sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`)] : []),
  ];
  // Inside a callout every line — code fences and blank lines included — carries the "> " prefix.
  return `${lines.map((line) => (line ? `> ${line}` : ">")).join("\n")}\n`;
}
