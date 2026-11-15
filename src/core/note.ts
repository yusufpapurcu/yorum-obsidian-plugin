import { Lexer } from "marked";
import type { Block } from "./types.js";

export interface ParsedNote {
  /** YAML frontmatter as Obsidian "properties"; values are always lists of strings. */
  properties: Record<string, string[]> | null;
  /** The note's Markdown after the frontmatter. */
  body: string;
  /** Top-level blocks of the body; block indexes are the anchor coordinates. */
  blocks: Block[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseNote(markdown: string): ParsedNote {
  const match = FRONTMATTER.exec(markdown);
  const body = match ? markdown.slice(match[0].length) : markdown;
  const blocks = Lexer.lex(body)
    .filter((token) => token.type !== "space")
    .map((token, index) => ({ index, type: token.type, raw: token.raw }));
  return { properties: match ? parseProperties(match[1]) : null, body, blocks };
}

/**
 * Index of the anchorable block containing `offset` (a character offset into the full note, as an
 * editor reports it), or the nearest block before it; null inside the frontmatter or an empty note.
 */
export function blockIndexAt(markdown: string, offset: number): number | null {
  const match = FRONTMATTER.exec(markdown);
  const start = match ? match[0].length : 0;
  if (offset < start) return null;
  const body = markdown.slice(start);
  let cursor = 0;
  let index = -1;
  let found: number | null = null;
  for (const token of Lexer.lex(body)) {
    // Locate the token's source text from the cursor; the lexer may normalize whitespace.
    const at = body.indexOf(token.raw, cursor);
    const from = at === -1 ? cursor : at;
    const to = from + token.raw.length;
    cursor = to;
    if (token.type === "space") continue;
    index++;
    if (from <= offset - start) found = index;
    if (offset - start < to) break;
  }
  return found;
}

/** The YAML subset Obsidian properties use: `key: value`, `key: [a, b]`, and `key:` + `- item` lists. */
function parseProperties(yaml: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let listKey: string | null = null;
  const clean = (value: string) => value.trim().replace(/^["']|["']$/g, "");
  for (const line of yaml.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      out[listKey].push(clean(item[1]));
      continue;
    }
    const pair = /^([^:#\s][^:]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1].trim();
    const value = pair[2].trim();
    if (value === "") {
      out[key] = [];
      listKey = key;
    } else {
      listKey = null;
      const inline = /^\[(.*)\]$/.exec(value);
      out[key] = inline ? inline[1].split(",").map(clean).filter(Boolean) : [clean(value)];
    }
  }
  return out;
}
