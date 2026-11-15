import { ACTIONS, isAction, lensInstruction } from "./actions.js";
import type { RelatedNote } from "./connections.js";
import type { ChatMessage, Sidecar, Thread } from "./types.js";

const BASE_INSTRUCTIONS = `You are a thinking partner who writes short comments in the margin of the user's personal notes.
The note belongs to the user. Never rewrite it or offer a replacement version of it. Respond only as a margin comment.
Help the user think: explain clearly, answer what was asked, and when useful ask one sharp question back.
Keep comments concise (usually under 150 words, not counting a visual). Use Markdown sparingly; small code snippets are fine when they help.
When a question depends on current or factual information you are unsure about, search the web; the app shows your sources.

Visual explanations: when a picture would make the idea clearly easier to grasp, or the user asks you to explain visually, include exactly one visual as a fenced block and keep the surrounding text short. Do not add visuals to simple answers. Formats:`;

const VISUAL_FORMATS = [
  `\`\`\`mermaid for flowcharts, call trees, sequence and state diagrams, hierarchies. Valid Mermaid only. Flowchart labels with punctuation go in quotes, e.g. A["fib(3)"]; sequence diagram participants use an alias, e.g. participant F3 as fib(3).`,
  `\`\`\`svg for a sketch built up step by step. One <svg> element with a viewBox no wider than 640. Wrap each step in <g data-step="1" data-caption="what this step shows">, numbering steps 1, 2, 3...; the app reveals them one at a time with the caption. Ink: stroke="currentColor" fill="none" for lines and shapes, fill="currentColor" for <text>, font-size 14 or more. No scripts, styles, images, links or foreignObject.`,
];

/** Base behaviour. */
export function basePrompt(): string {
  return `${BASE_INSTRUCTIONS}\n${VISUAL_FORMATS.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
}

const OTHER_THREADS_LIMIT = 8;

/** One-line summaries of the note's other threads, so the AI stays consistent with earlier commentary. */
function summarizeOtherThreads(sidecar: Sidecar, current: Thread): string {
  const lines = sidecar.threads
    .filter((t) => t.id !== current.id && t.messages.length > 0)
    .slice(-OTHER_THREADS_LIMIT)
    .map((t) => {
      const question = t.messages.find((m) => m.role === "user")?.content ?? "";
      const answer = [...t.messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
      const where = t.anchor ? `on "${truncate(t.anchor.quote, 80)}"` : "on the whole note";
      return `- ${where}: Q: ${truncate(question, 160)} | A: ${truncate(answer, 240)}`;
    });
  return lines.length ? `Earlier margin comments on this note:\n${lines.join("\n")}` : "";
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Build the chat request for a thread whose last message is the user's pending question.
 * Context order: base behaviour, the user's intent for this note, the current note text,
 * other commentary, then the anchored passage and the thread's history.
 */
export function buildMessages(params: {
  noteTitle: string;
  noteText: string;
  sidecar: Sidecar;
  thread: Thread;
  /** Other notes from the vault that relate to this question (links, backlinks, similar). */
  related?: RelatedNote[];
}): ChatMessage[] {
  const { noteTitle, noteText, sidecar, thread, related = [] } = params;
  const last = thread.messages[thread.messages.length - 1];
  const pendingAction = last?.role === "user" && isAction(last.action) ? last.action : null;
  const system = [
    basePrompt(),
    sidecar.intent.trim()
      ? `What the user told you about this note and how to help (follow this):\n${sidecar.intent.trim()}`
      : "",
    `The note "${noteTitle}" currently reads:\n<note>\n${noteText}\n</note>`,
    related.length
      ? `Other notes from the user's vault that may connect to this (excerpts). When one genuinely connects, say how and link it exactly as [[Note title]]; never invent note titles.\n${related
          .map((n) => `<vault-note title="${n.title}" relation="${n.relation}">\n${n.excerpt}\n</vault-note>`)
          .join("\n")}`
      : "",
    summarizeOtherThreads(sidecar, thread),
    thread.anchor
      ? `The user is commenting on this passage of the note:\n"""\n${thread.anchor.quote}\n"""`
      : "The user is commenting on the note as a whole.",
    thread.lens ? lensInstruction(thread.lens) : "",
    pendingAction ? `For this request: ${ACTIONS[pendingAction].instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    ...thread.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
}

/**
 * Ask for intent starters: the per-note system prompt is the most powerful control, yet real
 * usage left it empty on every note. Suggestions make it one click.
 */
export function buildIntentSuggestionMessages(noteTitle: string, noteText: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You help a writer configure a margin AI for one of their notes. Read the note and propose 3 clearly different intents the writer could give the AI: what the note is for and how the AI should help (e.g. quiz me, challenge my reasoning, connect ideas, help me finish a draft). Write each in the first person, in the note's language, at most 20 words. Output exactly 3 lines, one intent per line, no numbering, no quotes, nothing else.",
    },
    { role: "user", content: `Note "${noteTitle}":\n<note>\n${noteText}\n</note>` },
  ];
}

/** Clean the model's list: strip numbering, bullets and quotes; keep at most 3. */
export function parseIntentSuggestions(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["“'](.*)["”']$/, "$1").trim())
    .filter((line) => line.length > 0 && line.length <= 300)
    .slice(0, 3);
}
