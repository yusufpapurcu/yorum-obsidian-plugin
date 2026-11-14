import "dotenv/config";
import { stat } from "node:fs/promises";
import path from "node:path";
import { CommentaryService } from "./core/commentary.js";
import { clientFromEnv } from "./core/llm.js";
import { FsNoteStore } from "./node/fs-store.js";
import { VaultEvents, watchVault } from "./node/watch.js";
import { createApp } from "./server.js";

const vaultDir = path.resolve(process.argv[2] ?? process.env.VAULT_DIR ?? "sample-vault");
const port = Number(process.env.PORT ?? 4317);

const info = await stat(vaultDir).catch(() => null);
if (!info?.isDirectory()) {
  console.error(`Vault directory not found: ${vaultDir}`);
  process.exit(1);
}

const { client, model, webSearch, endpoint } = clientFromEnv(process.env);
const service = new CommentaryService(new FsNoteStore(vaultDir), client);
const moved = await service.migrateSidecars();
if (moved) console.log(`Moved ${moved} AI comment file(s) into ${vaultDir}/.yorum/`);
const events = new VaultEvents();
watchVault(vaultDir, (change) => events.emit(change));

const app = createApp(service, {
  model,
  webSearch,
  endpoint,
  obsidianConfigPath: process.env.OBSIDIAN_CONFIG?.trim() || undefined,
  events,
});

// Express 5 hands listen errors (e.g. EADDRINUSE) to this callback instead of throwing.
app.listen(port, "127.0.0.1", (error?: Error) => {
  if (error) {
    console.error(`Cannot listen on 127.0.0.1:${port}: ${error.message}`);
    process.exit(1);
  }
  console.log(`Vault: ${vaultDir}`);
  console.log(
    model
      ? `Model: ${model}${webSearch ? " (web search: Google grounding)" : ""}`
      : "LLM not configured (see .env.example); asking is disabled",
  );
  console.log(`Open http://127.0.0.1:${port}`);
});
