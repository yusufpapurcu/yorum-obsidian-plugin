import { parseNote } from "./note.js";
import { type NoteStore, titleOf } from "./store.js";

/**
 * Local, dependency-free retrieval over the vault so the AI can tie a question to the user's
 * other notes: explicit links (outgoing + backlinks) first, then TF-IDF similarity.
 */

export type Relation = "links to" | "linked from" | "similar";

export interface RelatedNote {
  path: string;
  title: string;
  relation: Relation;
  /** Start of the note body, trimmed to the excerpt budget. */
  excerpt: string;
}

interface IndexedNote {
  path: string;
  mtimeMs: number;
  title: string;
  body: string;
  /** Raw link targets as written: `[[Target]]`, `![[Target]]`, `[text](Target.md)`. */
  links: string[];
  tf: Map<string, number>;
}

const LINK = /!?\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]|\]\(([^)\s]+\.md)\)/g;
const WORD = /[\p{L}\p{N}]{3,}/gu;
// Very common words carry no topical signal (English + Turkish, the languages seen in use).
const STOPWORDS = new Set(
  (
    "the and for that this with you are was but not have has had from they their them what when where which " +
    "who will would can could should about into than then there these those its it's just also more some " +
    "very like been being does did doing your our out all any how why get got one two over only such " +
    "bir ve ile bu da de ama gibi icin için çok daha sonra olan olarak kadar ben sen biz siz onlar şey sey"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((w) => !STOPWORDS.has(w));
}

function termFrequencies(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const word of tokenize(text)) tf.set(word, (tf.get(word) ?? 0) + 1);
  return tf;
}

export class VaultIndex {
  private readonly cache = new Map<string, IndexedNote>();

  constructor(private readonly store: NoteStore) {}

  /** Path, title and body of every note (cached by mtime). */
  async documents(): Promise<{ path: string; title: string; body: string }[]> {
    return (await this.notes()).map(({ path: notePath, title, body }) => ({ path: notePath, title, body }));
  }

  /** All notes, re-reading only files whose mtime changed. */
  private async notes(): Promise<IndexedNote[]> {
    const notes = await this.store.listNotes();
    const fresh = await Promise.all(
      notes.map(async (notePath) => {
        const mtimeMs = await this.store.mtime(notePath);
        const cached = this.cache.get(notePath);
        if (cached && cached.mtimeMs === mtimeMs) return cached;
        const markdown = await this.store.readNote(notePath);
        const { body } = parseNote(markdown);
        const links = [...markdown.matchAll(LINK)].map((m) => decodeURI(m[1] ?? m[2]).trim());
        const entry: IndexedNote = { path: notePath, mtimeMs, title: titleOf(notePath), body, links, tf: termFrequencies(`${titleOf(notePath)} ${body}`) };
        this.cache.set(notePath, entry);
        return entry;
      }),
    );
    for (const key of this.cache.keys()) if (!notes.includes(key)) this.cache.delete(key);
    return fresh;
  }

  /**
   * Notes related to `notePath`, best first. `focus` (the anchored passage + question) weighs
   * more than the rest of the note when ranking by similarity.
   */
  async related(
    notePath: string,
    focus: string,
    options: { limit?: number; excerptChars?: number } = {},
  ): Promise<RelatedNote[]> {
    const { limit = 4, excerptChars = 1500 } = options;
    const all = await this.notes();
    const current = all.find((n) => n.path === notePath);
    if (!current) return [];
    const resolve = linkResolver(all.map((n) => n.path));

    const outgoing = new Set(current.links.map(resolve).filter((p): p is string => p !== null && p !== notePath));
    const incoming = new Set(
      all.filter((n) => n.path !== notePath && n.links.some((l) => resolve(l) === notePath)).map((n) => n.path),
    );

    // TF-IDF cosine between the question context and every other note.
    const df = new Map<string, number>();
    for (const n of all) for (const term of n.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    const idf = (term: string) => Math.log((all.length + 1) / ((df.get(term) ?? 0) + 1)) + 1;
    const query = termFrequencies(`${focus} ${focus} ${current.title} ${current.body}`);
    const weigh = (tf: Map<string, number>) => {
      const v = new Map<string, number>();
      let norm = 0;
      for (const [term, count] of tf) {
        const w = (1 + Math.log(count)) * idf(term);
        v.set(term, w);
        norm += w * w;
      }
      return { v, norm: Math.sqrt(norm) || 1 };
    };
    const q = weigh(query);
    const similarity = (n: IndexedNote) => {
      const d = weigh(n.tf);
      let dot = 0;
      let shared = 0;
      for (const [term, w] of q.v) {
        const dw = d.v.get(term);
        if (dw === undefined) continue;
        dot += w * dw;
        shared++;
      }
      return { score: dot / (q.norm * d.norm), shared };
    };

    // One shared word is coincidence (tiny notes score high on it); require a real overlap,
    // and enough text to judge — a note that is only an embed or a title says nothing topical.
    const SIMILAR_MIN = 0.08;
    const SHARED_MIN = 2;
    const WORDS_MIN = 12;
    const wordCount = (n: IndexedNote) => [...n.tf.values()].reduce((a, b) => a + b, 0);
    return all
      .filter((n) => n.path !== notePath && n.body.trim())
      .map((n) => {
        const sim = similarity(n);
        const relation: Relation | null = outgoing.has(n.path)
          ? "links to"
          : incoming.has(n.path)
            ? "linked from"
            : sim.score >= SIMILAR_MIN && sim.shared >= SHARED_MIN && wordCount(n) >= WORDS_MIN
              ? "similar"
              : null;
        // An explicit link is the user's own statement of relevance: rank it above any similarity.
        return { n, relation, score: (relation && relation !== "similar" ? 1 : 0) + sim.score };
      })
      .filter((r): r is { n: IndexedNote; relation: Relation; score: number } => r.relation !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ n, relation }) => ({
        path: n.path,
        title: n.title,
        relation,
        excerpt: n.body.length > excerptChars ? `${n.body.slice(0, excerptChars).trimEnd()}…` : n.body.trim(),
      }));
  }
}

/** Obsidian-style link resolution: exact path, path + `.md`, then file name (shortest path wins). */
export function linkResolver(notePaths: string[]): (target: string) => string | null {
  const byPath = new Map(notePaths.map((p) => [p.toLowerCase(), p]));
  const byName = new Map<string, string>();
  for (const p of [...notePaths].sort((a, b) => a.split("/").length - b.split("/").length)) {
    const name = titleOf(p).toLowerCase();
    if (!byName.has(name)) byName.set(name, p);
  }
  return (target) => {
    const t = target.trim().replace(/\\/g, "/").toLowerCase();
    return byPath.get(t) ?? byPath.get(`${t}.md`) ?? byName.get((t.split("/").pop() ?? t).replace(/\.md$/, "")) ?? null;
  };
}
