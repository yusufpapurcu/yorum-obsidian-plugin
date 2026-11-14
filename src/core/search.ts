import type { Sidecar } from "./types.js";

/**
 * Search across notes and their AI comments. Pure (no I/O) so the server and the Obsidian plugin
 * share it. Matching ignores case and accents, and treats Turkish ı/İ as i — so "kitabi" finds
 * "kitabı" and "ozel" finds "özel".
 */

export interface SearchDocument {
  path: string;
  title: string;
  /** Note body (frontmatter excluded). */
  body: string;
  sidecar: Sidecar;
}

export interface Snippet {
  text: string;
  /** [start, end) ranges inside `text` that matched a search term. */
  highlights: [number, number][];
}

export interface CommentHit {
  threadId: string;
  role: "user" | "assistant";
  snippet: Snippet;
}

export interface SearchHit {
  path: string;
  title: string;
  titleHighlights: [number, number][];
  /** Matches in the note itself. */
  snippets: Snippet[];
  /** Matches in the AI commentary (questions and answers). */
  comments: CommentHit[];
  score: number;
}

const SNIPPET_RADIUS = 60;
const MAX_SNIPPETS = 2;
const MAX_COMMENT_HITS = 3;
const MAX_RESULTS = 30;
// Sketch and chart sources are markup, not prose: matching inside them is noise.
const NOISY_FENCES = /```(?:svg|vega-lite)[\s\S]*?```/g;

/**
 * Markdown → readable text for matching and snippets: no markup, math, link targets or fence
 * markers, but the words of links, headings, callout titles and diagrams stay findable.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(NOISY_FENCES, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/^```.*$/gm, " ")
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>\s*\[![\w-]+\][+-]?\s*/gm, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|==|~~|`)/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|[.,;:!?)]|$)/g, "$1$2")
    // Obsidian's inline-math rule: no space inside the dollars, no digit after ("$5 and $10" stays).
    .replace(/\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g, "$1");
}

/** Fold one character for matching: lowercase, no diacritics, Turkish dotless/dotted i → i. */
function foldChar(c: string): string {
  if (c === "ı" || c === "İ" || c === "I") return "i";
  return c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Folded text plus, for every folded character, the index of the original character it came from. */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = "";
  const origin: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    for (const f of foldChar(ch)) {
      folded += f;
      origin.push(i);
    }
    i += ch.length;
  }
  return { folded, origin };
}

export function parseQuery(query: string): string[] {
  return [...new Set(fold(query).folded.split(/\s+/).filter((t) => t.length >= 2))];
}

/** Ranges (in original-text indexes) where any term occurs. */
function findMatches(text: string, terms: string[]): [number, number][] {
  const { folded, origin } = fold(text);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let at = folded.indexOf(term);
    while (at !== -1) {
      const start = origin[at];
      const lastOrigin = origin[at + term.length - 1];
      const end = lastOrigin + String.fromCodePoint(text.codePointAt(lastOrigin)!).length;
      ranges.push([start, end]);
      at = folded.indexOf(term, at + term.length);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** A window of text around `center`, with whitespace collapsed and highlights re-based. */
function snippetAround(text: string, ranges: [number, number][], center: [number, number]): Snippet {
  let from = Math.max(0, center[0] - SNIPPET_RADIUS);
  let to = Math.min(text.length, center[1] + SNIPPET_RADIUS);
  // Don't cut words in half.
  while (from > 0 && /\S/.test(text[from - 1])) from--;
  while (to < text.length && /\S/.test(text[to])) to++;
  const raw = text.slice(from, to);
  // Collapse whitespace while tracking how highlight offsets shift.
  let out = from > 0 ? "…" : "";
  const map: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    map[i] = out.length;
    if (/\s/.test(raw[i])) {
      if (!out.endsWith(" ") && out.length > 0) out += " ";
    } else {
      out += raw[i];
    }
  }
  map[raw.length] = out.length;
  if (to < text.length) out += "…";
  const highlights = ranges
    .filter(([s, e]) => s >= from && e <= to)
    .map(([s, e]): [number, number] => [map[s - from], map[e - from]]);
  return { text: out, highlights };
}

/** Up to `limit` snippets for the text, each centred on a match not already shown. */
function snippetsFor(text: string, ranges: [number, number][], limit: number): Snippet[] {
  const out: Snippet[] = [];
  let shownUntil = -1;
  for (const range of ranges) {
    if (out.length >= limit) break;
    if (range[0] < shownUntil) continue;
    out.push(snippetAround(text, ranges, range));
    shownUntil = range[1] + SNIPPET_RADIUS;
  }
  return out;
}

/**
 * Notes where every term appears somewhere (title, body or comments), best first.
 * Title matches weigh most, then the note's own words, then the commentary.
 */
export function searchVault(documents: SearchDocument[], query: string): SearchHit[] {
  const terms = parseQuery(query);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const doc of documents) {
    const body = plainText(doc.body);
    const titleRanges = findMatches(doc.title, terms);
    const bodyRanges = findMatches(body, terms);
    const messages = doc.sidecar.threads.flatMap((thread) =>
      thread.messages.map((m) => {
        const text = plainText(m.content);
        return { threadId: thread.id, role: m.role, text, ranges: findMatches(text, terms) };
      }),
    );
    const everything = fold(`${doc.title}\n${body}\n${messages.map((m) => m.text).join("\n")}`).folded;
    if (!terms.every((t) => everything.includes(t))) continue;

    const commentMatches = messages.filter((m) => m.ranges.length);
    const comments = commentMatches.slice(0, MAX_COMMENT_HITS).map((m) => ({
      threadId: m.threadId,
      role: m.role,
      snippet: snippetsFor(m.text, m.ranges, 1)[0],
    }));
    const score =
      titleRanges.length * 5 +
      Math.min(bodyRanges.length, 20) +
      Math.min(commentMatches.reduce((n, m) => n + m.ranges.length, 0), 20) * 0.75;
    hits.push({
      path: doc.path,
      title: doc.title,
      titleHighlights: titleRanges,
      snippets: snippetsFor(body, bodyRanges, MAX_SNIPPETS),
      comments,
      score,
    });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, MAX_RESULTS);
}
