import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type NoteStore, VaultError, checkVaultPath } from "../src/core/store.js";

/** Notes and sidecars in a folder on disk: the vault stand-in for core tests. */
export class FsNoteStore implements NoteStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async listNotes(): Promise<string[]> {
    const notes: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        // Hidden folders (.obsidian, .git, .yorum) are app data, not vault content.
        if (entry.name.startsWith(".")) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          notes.push(path.relative(this.root, abs).split(path.sep).join("/"));
        }
      }
    };
    await walk(this.root);
    return notes.sort((a, b) => a.localeCompare(b));
  }

  /** Absolute path of a note, rejecting anything outside the vault or hidden. */
  private notePath(relPath: string): string {
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
      return await readFile(this.notePath(notePath), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new VaultError(`Note not found: ${notePath}`, 404);
      throw err;
    }
  }

  async mtime(notePath: string): Promise<number> {
    return (await stat(this.notePath(notePath))).mtimeMs;
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
