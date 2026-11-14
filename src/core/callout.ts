import type { Source } from "./types.js";

/**
 * Bring an AI comment into your own note, on your terms: Markdown that Obsidian renders natively —
 * a foldable callout with the passage, the question, the answer, its sources, and its visual.
 * Shared by the web UI (served as /core/callout.js) and the Obsidian plugin.
 */

const SVG_FENCE = /```svg\s*\n([\s\S]*?)```/g;

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
  const body = answer.replace(SVG_FENCE, (_, svg: string) => svg.trim().replace(/\n\s*\n/g, "\n"));
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
