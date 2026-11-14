# yorum — talk with your notes

*Yorum* is Turkish for "comment" and "interpretation". It's an AI commentary layer for Markdown notes and Obsidian: you write, and the AI answers in a comment panel beside your note, pinned to the passage you asked about. Your notes are never modified. Everything the AI says lives in one hidden `.yorum/` folder at the vault root, one JSON file per note mirroring its path.

```
vault/
  Study/Recursion.md             ← yours, never written by yorum
  .yorum/Study/Recursion.json    ← intent + comment threads for that note
```

The folder is hidden like `.obsidian/`, so it stays out of Obsidian's file explorer and away from your notes, and all AI changes group under one path in git. Sidecars from earlier versions (`.margin/…json`, or `<note>.ai.json` next to the note) are moved there automatically.

It comes as an **Obsidian plugin** and as a small **local web app**. Both share the same core and data format, so you can use either on the same vault.

## What it does

- **Tell it what a note is for**: a per-note system prompt in your words ("I'm struggling with recursion, quiz me"), or pick a starter / **✨ Suggest for this note**.
- **Select text** → **Ask… · Explain · Simplify · Challenge me · Visualize · Lens…**, or ask about the whole note.
- **Lens…** explains a passage through a framework from another field (C.S. Holling's Adaptive Cycle, game theory, thermodynamics… or ✨ Surprise me). You get a mapping, the insight it reveals, and where the analogy breaks.
- **Threads**: reply, push back, or use **Another angle · Visualize · Challenge me · Simplify**. Answers stream in, and the AI only speaks when asked.
- **Vault connections**: up to four related notes (links, backlinks, similar notes) go into each request, and answers link them as `[[Note]]`.
- **Visuals**: Mermaid diagrams, step-by-step SVG sketches, and Vega-Lite charts (charts are drawn in the web app only).
- **Web search** with citations and a source list (Gemini models via Google Search grounding).
- **What the AI sees** shows the exact request (destination, model, every vault note included, size) before anything is sent.
- **Search** across note titles, note text *and* AI comments. It ignores accents and treats Turkish ı as i.
- **Bring answers home**: insert an answer below the passage as an `[!ai]` callout, or copy it. Nothing is written to your note unless you click.

Each request sends: base instructions, your intent, the current note, related vault notes (excerpts), short summaries of the note's other threads, the anchored passage, any lens or quick-action instruction, and the thread history. Explain and Simplify use the model's faster thinking level.

## Obsidian plugin

```sh
git clone https://github.com/yusufpapurcu/yorum-obsidian-plugin && cd yorum-obsidian-plugin
npm install
npm run plugin:install -- /path/to/your/vault   # builds and copies main.js, manifest.json, styles.css into .obsidian/plugins/yorum/
```

Then in Obsidian (1.11.4 or newer), go to Settings → Community plugins, enable **Yorum**, and set the base URL and model in its settings. The plugin needs no Node APIs, so it should also work on mobile (not yet tested there).

- **API key**: pick or create a secret. It is kept in Obsidian's Keychain (secret storage) on that device, never in the vault; `data.json` only stores the secret's name. Enter it once per device. Any OpenAI-compatible endpoint works, as long as it allows requests from Obsidian (CORS).
- **Yorum panel** (ribbon icon or "Yorum: Open panel") follows the active note: intent + starters, threads rendered by Obsidian itself (Mermaid, math, `[[links]]`), streaming answers, follow-up chips, *What the AI sees*. Click a diagram to see it full size.
- **Select text** → right-click → *Yorum: Ask… / Explain / Simplify / Challenge me / Visualize / Lens…*, or the same commands from the command palette.
- **Highlights** in the editor mark commented passages. Clicking one opens its thread; clicking a thread's quote selects the passage.
- **Yorum: Search notes & AI comments** opens search; a comment hit opens its thread.
- **Renames and moves follow the note**: renaming or moving a note (or a whole folder) in Obsidian moves its AI comments along, merging with any leftover data at the new path, and removes emptied folders. A rename made *outside* Obsidian while it runs reaches Obsidian as a delete plus a create, so those comments stay at the old path.
- **Delete AI comments with their note** (setting, off by default): when on, deleting a note or folder also deletes its AI comments. When off, they stay and reappear if a note with the same path is created again.

### With obsidian-git

- `.yorum/` is committed, diffed and synced like your notes: pretty-printed JSON, written only when you ask, reply, save an intent or delete a thread. obsidian-git commits hidden folders unless your `.gitignore` excludes them.
- `.obsidian/plugins/yorum/data.json` contains no secrets and is safe to commit.
- Renames made in Obsidian move the `.yorum/` file in the same commit, so a pull on another device brings both.
- Obsidian doesn't report changes inside hidden folders. After a pull, the panel shows new comments when you switch notes.
- Known gap: commenting on the same note from two devices between syncs can conflict on the sidecar's `updatedAt` line.

## Local web app

```sh
cp .env.example .env   # any OpenAI-compatible endpoint: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
npm install
npm run build
npm start                       # serves ./sample-vault on http://127.0.0.1:4317
npm start -- /path/to/folder    # or VAULT_DIR=...; PORT=... to change the port
```

- **Layout**: three columns (notes · the note, rendered like Obsidian · comments).
- **Live sync**: edits made in Obsidian or by a git pull show up live.
- **Open in Obsidian ↗** jumps back to the note when the folder is a registered vault.
- **Charts**: Vega-Lite charts are drawn here.
- **Without a complete `.env`** the UI still opens; asking returns an error naming the missing keys.
- **`OBSIDIAN_CONFIG`** points at Obsidian's `obsidian.json` if it isn't in the default place.
- **Web search**: with a Gemini model, requests go through the gateway's native Gemini endpoint (`<origin of OPENAI_BASE_URL>/v1beta`; override with `GEMINI_BASE_URL`) with Google Search grounding. `WEB_SEARCH=off` turns it off.
- **Renames**: the web app does not track renames; that's the plugin's job.

## Sidecar format (`.yorum/<note path>.json`)

```json
{
  "version": 1,
  "intent": "I'm struggling with recursion, quiz me",
  "threads": [
    {
      "id": "…",
      "anchor": { "blockIndex": 2, "quote": "how the answer actually comes back out" },
      "createdAt": "…",
      "lens": "C.S. Holling's Adaptive Cycle",
      "messages": [
        { "id": "…", "role": "user", "content": "Explain this visually.", "createdAt": "…", "action": "visualize" },
        { "id": "…", "role": "assistant", "content": "… [[1]](https://…)", "createdAt": "…",
          "sources": [{ "title": "python.org", "url": "https://docs.python.org/…" }],
          "related": ["Systems thinking.md"] }
      ]
    }
  ],
  "updatedAt": "…"
}
```

**Fields:**
- **`blockIndex`** is the top-level Markdown block of the note body (frontmatter excluded). If the note changes, the quote is found again anywhere in the note; if it's gone, the thread is marked as changed.
- **`anchor: null`** means a note-level thread.
- **Optional fields:** `lens` (the thread's concept lens), `action` (the quick action that sent a user message), `sources` (web search), `related` (vault notes given to the AI for that answer).

## Development

```sh
npm test               # Vitest, mocked LLM
npm run build          # web app (TypeScript → dist/)
npm run plugin:build   # Obsidian plugin → obsidian-plugin/main.js
```

- `src/core/`: framework-free, I/O-free logic shared by the web app and the plugin. It covers the `NoteStore` interface, note parsing, sidecars, vault connections, search, quick actions and lenses, prompt assembly, LLM clients with streaming and Gemini grounding, callout export, and `CommentaryService`.
- `src/node/`: the web app's server side (filesystem store, vault watcher, Obsidian vault lookup); `src/server.ts` and `src/index.ts` hold the HTTP API and entry point.
- `public/`: the web UI (plain HTML/CSS/JS, no build step).
- `obsidian-plugin/`: the plugin (`NoteStore` on Obsidian's vault API, panel, editor highlights, modals).
- `sample-vault/`: a few demo notes to try it on.
