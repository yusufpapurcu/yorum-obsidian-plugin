import { Marked } from "/vendor/marked.esm.js";

/**
 * Obsidian-flavoured Markdown shared by notes and AI comments:
 * [[wikilinks]], ![[embeds]], > [!callouts], ==highlights==, #tags, $math$ and $$math$$.
 * Links resolve against the vault index the way Obsidian does: by path, else by file name.
 */

export const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const vault = { obsidian: null, notes: [], files: [], byName: new Map() };

/** `obsidian` is the registered Obsidian vault containing this folder ({ name, subfolder }) or null. */
export function setVaultIndex({ obsidian, notes, files }) {
  vault.obsidian = obsidian;
  vault.notes = notes;
  vault.files = files;
  vault.byName.clear();
  // Shortest path wins when two files share a name, like Obsidian's default link resolution.
  const sorted = [...notes, ...files].sort((a, b) => a.split("/").length - b.split("/").length);
  for (const path of sorted) {
    const name = path.split("/").pop().toLowerCase();
    const key = name.endsWith(".md") ? name.slice(0, -3) : name;
    if (!vault.byName.has(key)) vault.byName.set(key, path);
  }
}

/** Resolve a link target (`Note`, `folder/Note`, `picture.png`) to a vault path, or null. */
export function resolveLink(target) {
  const clean = target.trim().replace(/\\/g, "/");
  const lower = clean.toLowerCase();
  const all = [...vault.notes, ...vault.files];
  const exact =
    all.find((p) => p.toLowerCase() === lower) ?? all.find((p) => p.toLowerCase() === `${lower}.md`);
  if (exact) return exact;
  const name = lower.split("/").pop();
  return vault.byName.get(name.endsWith(".md") ? name.slice(0, -3) : name) ?? null;
}

export const isNote = (path) => path.toLowerCase().endsWith(".md");

/** Deep link that opens a vault file in the Obsidian app, or null when Obsidian doesn't know this folder. */
export function obsidianUrl(path) {
  if (!vault.obsidian) return null;
  const file = vault.obsidian.subfolder ? `${vault.obsidian.subfolder}/${path}` : path;
  return `obsidian://open?vault=${encodeURIComponent(vault.obsidian.name)}&file=${encodeURIComponent(file)}`;
}

export const NOT_IN_OBSIDIAN =
  "This folder isn't an Obsidian vault yet. In Obsidian: Open another vault → Open folder as vault.";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

function renderWikilink({ embed, target, alias }) {
  const [file, heading] = target.split("#");
  const path = resolveLink(file || "");
  const label = escapeHtml(alias ?? (heading && file ? `${file} › ${heading}` : target));
  if (!path) return `<span class="internal-link unresolved" title="Not in this vault">${label}</span>`;

  if (embed && IMAGE.test(path)) {
    const width = /^\d+$/.test(alias ?? "") ? ` width="${alias}"` : "";
    return `<img class="embed-image" src="/api/file?path=${encodeURIComponent(path)}" alt="${escapeHtml(file)}"${width}>`;
  }
  if (embed && isNote(path)) {
    return `<div class="embed" data-embed-path="${escapeHtml(path)}"><a class="internal-link" href="#${encodeURIComponent(path)}">${label}</a></div>`;
  }
  if (embed || !isNote(path)) {
    // Bases, canvases, PDFs…: Obsidian renders these; hand off to it.
    const kind = `<span class="embed-kind">${escapeHtml(path.split(".").pop().toLowerCase())}</span>`;
    const name = escapeHtml(path.split("/").pop());
    const url = obsidianUrl(path);
    return url
      ? `<a class="embed-file" href="${url}" title="Open in Obsidian">${kind}${name}<span class="embed-open">Open in Obsidian ↗</span></a>`
      : `<span class="embed-file" title="${escapeHtml(NOT_IN_OBSIDIAN)}">${kind}${name}<span class="embed-open">rendered by Obsidian</span></span>`;
  }
  return `<a class="internal-link" href="#${encodeURIComponent(path)}" data-path="${escapeHtml(path)}">${label}</a>`;
}

function mathPlaceholder(tex, display) {
  const tag = display ? "div" : "span";
  return `<${tag} class="math${display ? " math-display" : ""}" data-tex="${escapeHtml(tex)}">${escapeHtml(tex)}</${tag}>`;
}

const extensions = [
  {
    name: "wikilink",
    level: "inline",
    start: (src) => src.match(/!?\[\[/)?.index,
    tokenizer(src) {
      const m = /^(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/.exec(src);
      if (m) return { type: "wikilink", raw: m[0], embed: m[1] === "!", target: m[2], alias: m[3] };
    },
    renderer: (token) => renderWikilink(token),
  },
  {
    name: "highlight",
    level: "inline",
    start: (src) => src.indexOf("=="),
    tokenizer(src) {
      const m = /^==(?=\S)([^=\n]+?)(?<=\S)==/.exec(src);
      if (m) return { type: "highlight", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
    },
    renderer(token) {
      return `<mark class="hl">${this.parser.parseInline(token.tokens)}</mark>`;
    },
  },
  {
    name: "tag",
    level: "inline",
    start: (src) => {
      const m = /(^|\s)#[\p{L}\p{N}_/-]*\p{L}/u.exec(src);
      return m ? m.index + m[1].length : undefined;
    },
    tokenizer(src) {
      const m = /^#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/u.exec(src);
      if (m) return { type: "tag", raw: m[0], tag: m[1] };
    },
    renderer: (token) => `<span class="tag">#${escapeHtml(token.tag)}</span>`,
  },
  {
    name: "mathBlock",
    level: "block",
    start: (src) => src.match(/^\$\$/m)?.index,
    tokenizer(src) {
      const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
      if (m) return { type: "mathBlock", raw: m[0], tex: m[1].trim() };
    },
    renderer: (token) => mathPlaceholder(token.tex, true),
  },
  {
    name: "mathInline",
    level: "inline",
    start: (src) => src.indexOf("$"),
    tokenizer(src) {
      const display = /^\$\$([^$]+?)\$\$/.exec(src);
      if (display) return { type: "mathInline", raw: display[0], tex: display[1].trim(), display: true };
      // Obsidian's rule: no space just inside the dollars, and no digit right after ("$5 and $10" stays text).
      const m = /^\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/.exec(src);
      if (m) return { type: "mathInline", raw: m[0], tex: m[1], display: false };
    },
    renderer: (token) => mathPlaceholder(token.tex, token.display),
  },
];

/**
 * @param {{ allowHtml: boolean, visualKinds: Record<string, true> }} options
 *   allowHtml — notes are the user's own files (raw HTML allowed, as in Obsidian); AI output is escaped.
 *   visualKinds — fenced languages rendered as visuals (hydrated later by visuals.js).
 */
export function createMarked({ allowHtml, visualKinds }) {
  return new Marked({
    gfm: true,
    extensions,
    renderer: {
      ...(allowHtml ? {} : { html: ({ text }) => escapeHtml(text) }),
      code({ text, lang }) {
        const kind = (lang ?? "").trim().toLowerCase();
        if (!visualKinds[kind]) return false;
        return `<div class="viz" data-kind="${kind}"><pre class="viz-src">${escapeHtml(text)}</pre></div>`;
      },
      blockquote(token) {
        const inner = this.parser.parse(token.tokens);
        const m = /^<p>\[!([\w-]+)\]([+-]?)[ \t]*([^\n<]*)(\n|<\/p>\n?)/.exec(inner);
        if (!m) return false;
        const [whole, type, fold, title, end] = m;
        const rest = end === "\n" ? `<p>${inner.slice(whole.length)}` : inner.slice(whole.length);
        // `title` comes from marked's HTML output, so it is already escaped; the type is [\w-]+.
        const heading = title.trim() || type.charAt(0).toUpperCase() + type.slice(1);
        const kind = escapeHtml(type.toLowerCase());
        if (fold) {
          return `<details class="callout" data-callout="${kind}"${fold === "+" ? " open" : ""}><summary class="callout-title">${heading}</summary><div class="callout-content">${rest}</div></details>`;
        }
        return `<div class="callout" data-callout="${kind}"><div class="callout-title">${heading}</div><div class="callout-content">${rest}</div></div>`;
      },
    },
  });
}
