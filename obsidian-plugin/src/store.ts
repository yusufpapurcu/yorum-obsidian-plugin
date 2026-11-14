import type { App } from "obsidian";
import { type NoteStore, VaultError, type VaultListing } from "../../src/core/store.js";

/** Notes and sidecars through Obsidian's vault API (works on desktop and mobile). */
export class ObsidianNoteStore implements NoteStore {
  constructor(private readonly app: App) {}

  async scan(): Promise<VaultListing> {
    const notes: string[] = [];
    const files: string[] = [];
    // The vault index already skips hidden folders such as .obsidian and .yorum.
    for (const file of this.app.vault.getFiles()) {
      if (file.path.endsWith(".ai.json")) continue; // old sidecar left without its note
      (file.extension === "md" ? notes : files).push(file.path);
    }
    const byName = (a: string, b: string) => a.localeCompare(b);
    return { notes: notes.sort(byName), files: files.sort(byName) };
  }

  async readNote(notePath: string): Promise<string> {
    const file = this.app.vault.getFileByPath(notePath);
    if (!file) throw new VaultError(`Note not found: ${notePath}`, 404);
    return this.app.vault.cachedRead(file);
  }

  async mtime(notePath: string): Promise<number> {
    return this.app.vault.getFileByPath(notePath)?.stat.mtime ?? 0;
  }

  // Data files may live in the hidden .yorum folder, which the vault index doesn't track, so they
  // go through the adapter directly.
  async readData(path: string): Promise<string | null> {
    return (await this.app.vault.adapter.exists(path)) ? this.app.vault.adapter.read(path) : null;
  }

  async writeData(path: string, text: string): Promise<void> {
    const { adapter } = this.app.vault;
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
    }
    await adapter.write(path, text);
  }

  async deleteData(path: string): Promise<void> {
    if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
  }
}
