import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type NoteStore, VaultError, type VaultListing, checkVaultPath } from "../core/store.js";

const IGNORED_DIRS: Record<string, true> = { node_modules: true };

/** Notes and sidecars in a folder on disk (the local server). */
export class FsNoteStore implements NoteStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async scan(): Promise<VaultListing> {
    const notes: string[] = [];
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Hidden folders (.obsidian, .git, .yorum) are app data, not vault content.
        if (entry.name.startsWith(".")) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS[entry.name]) await walk(abs);
        } else if (entry.isFile() && !entry.name.endsWith(".ai.json")) { // old sidecar left without its note
          const rel = path.relative(this.root, abs).split(path.sep).join("/");
          (entry.name.toLowerCase().endsWith(".md") ? notes : files).push(rel);
        }
      }
    };
    await walk(this.root);
    const byName = (a: string, b: string) => a.localeCompare(b);
    return { notes: notes.sort(byName), files: files.sort(byName) };
  }

  /** Absolute path of a vault file from a request, rejecting anything outside the vault or hidden. */
  resolvePath(relPath: string): string {
    return path.join(this.root, ...checkVaultPath(relPath).split("/"));
  }

  /** Absolute path of an internal data file (may be hidden, never outside the vault). */
  private dataPath(relPath: string): string {
    const abs = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new VaultError("Path escapes the vault", 400);
    return abs;
  }

  async readNote(notePath: string): Promise<string> {
    try {
      return await readFile(this.resolvePath(notePath), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new VaultError(`Note not found: ${notePath}`, 404);
      throw err;
    }
  }

  async mtime(notePath: string): Promise<number> {
    return (await stat(this.resolvePath(notePath))).mtimeMs;
  }

  async readData(relPath: string): Promise<string | null> {
    try {
      return await readFile(this.dataPath(relPath), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Atomic write (temp file + rename) so a crash never leaves a half-written file. */
  async writeData(relPath: string, text: string): Promise<void> {
    const target = this.dataPath(relPath);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${randomUUID()}`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, target);
  }

  async deleteData(relPath: string): Promise<void> {
    await rm(this.dataPath(relPath), { force: true });
  }
}
