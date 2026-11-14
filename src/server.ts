import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { ACTIONS, LENS_PRESETS } from "./core/actions.js";
import type { AnswerHooks, CommentaryService } from "./core/commentary.js";
import { LlmError } from "./core/errors.js";
import { VaultError } from "./core/store.js";
import type { Thread } from "./core/types.js";
import type { FsNoteStore } from "./node/fs-store.js";
import { findObsidianVault } from "./node/obsidian.js";
import type { VaultEvents } from "./node/watch.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const packagePath = (...parts: string[]) => path.join(ROOT, "node_modules", ...parts);

/** Browser builds served to the UI; visual renderers are loaded only when a comment needs them. */
const VENDOR_FILES: Record<string, string> = {
  "marked.esm.js": packagePath("marked", "lib", "marked.esm.js"),
  "purify.es.mjs": packagePath("dompurify", "dist", "purify.es.mjs"),
  "vega.min.js": packagePath("vega", "build", "vega.min.js"),
  "vega-lite.min.js": packagePath("vega-lite", "build", "vega-lite.min.js"),
  "vega-embed.min.js": packagePath("vega-embed", "build", "vega-embed.min.js"),
};

/** Pure core modules the browser UI shares with the server and the Obsidian plugin (compiled JS). */
const CORE_FILES: Record<string, string> = {
  "callout.js": path.join(ROOT, "dist", "core", "callout.js"),
};

const IMAGE_EXTENSIONS: Record<string, true> = {
  ".png": true,
  ".jpg": true,
  ".jpeg": true,
  ".gif": true,
  ".webp": true,
  ".svg": true,
  ".bmp": true,
  ".avif": true,
};

/** Note paths travel as `?path=` so nested folders and spaces need no route escaping. */
function notePath(req: Request): string {
  const value = req.query.path;
  if (typeof value !== "string" || !value) throw new VaultError("Missing ?path=", 400);
  return value;
}

const wantsStream = (req: Request) => (req.get("accept") ?? "").includes("text/event-stream");

/**
 * Stream an answer as server-sent events: one `context` event naming the vault notes being read,
 * `delta` events with text as it is generated, then one `done` event with the saved thread
 * (citations resolved) — or an `error` event.
 */
async function streamReply(res: Response, run: (hooks: AnswerHooks) => Promise<Thread>) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const thread = await run({
      onContext: (related) => send("context", { notes: related.map((n) => ({ path: n.path, relation: n.relation })) }),
      onDelta: (text) => send("delta", { text }),
    });
    send("done", thread);
  } catch (err) {
    const status = err instanceof VaultError ? err.status : err instanceof LlmError ? 502 : 500;
    if (status === 500) console.error(err);
    send("error", { status, error: status === 500 ? "Internal error" : (err as Error).message });
  }
  res.end();
}

export function createApp(
  service: CommentaryService<FsNoteStore>,
  info: {
    model: string | null;
    webSearch: boolean;
    /** Host model requests go to, shown in the context inspector. */
    endpoint?: string | null;
    obsidianConfigPath?: string;
    events?: VaultEvents;
  },
) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/status", async (_req, res) => {
    res.json({
      vault: service.store.root,
      model: info.model,
      llmConfigured: info.model !== null,
      webSearch: info.webSearch,
      // Looked up per request so adding the folder as a vault in Obsidian takes effect on reload.
      obsidian: await findObsidianVault(service.store.root, info.obsidianConfigPath),
    });
  });

  /** Live sync: vault changes (e.g. typing in Obsidian) pushed to the browser as server-sent events. */
  app.get("/api/events", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    const unsubscribe = info.events?.subscribe((change) => res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`));
    // Comment pings keep idle connections from being closed by the browser or proxies.
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe?.();
    });
  });

  app.get("/api/notes", async (_req, res) => {
    res.json(await service.listing());
  });

  app.get("/api/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    res.json({ query: q, results: await service.search(q) });
  });

  /** Images embedded with `![[picture.png]]`. */
  app.get("/api/file", (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    if (!IMAGE_EXTENSIONS[path.extname(rel).toLowerCase()]) throw new VaultError("Only images are served", 400);
    res.sendFile(service.store.resolvePath(rel), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: `File not found: ${rel}` });
    });
  });

  app.get("/api/note", async (req, res) => {
    res.json(await service.getNote(notePath(req)));
  });

  app.put("/api/note/intent", async (req, res) => {
    res.json(await service.setIntent(notePath(req), req.body?.intent));
  });

  app.post("/api/note/intent-suggestions", async (req, res) => {
    res.json({ suggestions: await service.suggestIntents(notePath(req)) });
  });

  /** Quick actions and lens presets, so the UI and the server share one list. */
  app.get("/api/actions", (_req, res) => {
    res.json({
      actions: Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label })),
      lenses: LENS_PRESETS,
    });
  });

  app.post("/api/note/threads", async (req, res) => {
    const input = {
      anchor: req.body?.anchor ?? null,
      question: req.body?.question,
      action: req.body?.action,
      lens: req.body?.lens,
    };
    if (wantsStream(req)) return streamReply(res, (hooks) => service.ask(notePath(req), input, hooks));
    res.status(201).json(await service.ask(notePath(req), input));
  });

  app.post("/api/note/threads/:id/messages", async (req, res) => {
    const input = { content: req.body?.content, action: req.body?.action };
    if (wantsStream(req)) {
      return streamReply(res, (hooks) => service.reply(notePath(req), req.params.id, input, hooks));
    }
    res.json(await service.reply(notePath(req), req.params.id, input));
  });

  /**
   * The context inspector: exactly what the next request would send, without sending it.
   * Local-first trust — the user can see that only this leaves the machine.
   */
  app.post("/api/note/context-preview", async (req, res) => {
    const body = req.body ?? {};
    const preview = body.threadId
      ? await service.preview(notePath(req), {
          threadId: String(body.threadId),
          content: body.content || (body.action ? undefined : "(your reply)"),
          action: body.action,
        })
      : await service.preview(notePath(req), {
          anchor: body.anchor ?? null,
          question: body.question || (body.action || body.lens ? undefined : "(your question)"),
          action: body.action,
          lens: body.lens,
        });
    const characters = preview.messages.reduce((n, m) => n + m.content.length, 0);
    res.json({
      destination: { endpoint: info.endpoint ?? null, model: info.model, webSearch: info.webSearch, fast: preview.fast },
      related: preview.related.map((n) => ({ path: n.path, relation: n.relation, characters: n.excerpt.length })),
      messages: preview.messages,
      characters,
      // ~4 characters per token for English prose; a size estimate, not a bill.
      approxTokens: Math.round(characters / 4),
    });
  });

  app.delete("/api/note/threads/:id", async (req, res) => {
    res.json(await service.deleteThread(notePath(req), req.params.id));
  });

  for (const [route, file] of Object.entries(VENDOR_FILES)) {
    app.get(`/vendor/${route}`, (_req, res) => res.sendFile(file));
  }
  for (const [route, file] of Object.entries(CORE_FILES)) {
    app.get(`/core/${route}`, (_req, res) => res.sendFile(file));
  }
  // These builds load chunks / fonts relative to themselves.
  app.use("/vendor/mermaid", express.static(packagePath("mermaid", "dist")));
  app.use("/vendor/katex", express.static(packagePath("katex", "dist")));
  app.use(express.static(PUBLIC_DIR));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof VaultError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof LlmError) {
      res.status(502).json({ error: err.message });
    } else {
      console.error(err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  return app;
}
