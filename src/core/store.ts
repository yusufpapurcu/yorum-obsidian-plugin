/**
 * Where notes and sidecars live. The core never touches a filesystem directly: the local server
 * uses a Node filesystem store (`src/node/fs-store.ts`), the Obsidian plugin uses the vault API.
 * Paths are vault-relative with `/` separators.
 */
export interface NoteStore {
  scan(): Promise<VaultListing>;
  /** Markdown of a note; throws `VaultError` 404 when it doesn't exist. */
  readNote(notePath: string): Promise<string>;
  /** Last modification time in ms, so indexes re-read only what changed. */
  mtime(notePath: string): Promise<number>;
  /**
   * Data files the commentary layer manages (sidecars), by vault-relative path — these may live in
   * a hidden folder. `readData` returns null when the file doesn't exist; `writeData` creates
   * missing parent folders.
   */
  readData(path: string): Promise<string | null>;
  writeData(path: string, text: string): Promise<void>;
  deleteData(path: string): Promise<void>;
}

export interface VaultListing {
  /** Vault-relative `.md` paths, sorted. */
  notes: string[];
  /** Every other file (attachments, `.base`, `.canvas`, PDFs…), for resolving `![[embeds]]`. */
  files: string[];
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Validate a vault-relative path from a request: no escaping the vault, no hidden folders
 * (`.obsidian`, `.git`), POSIX separators. Returns the normalized path.
 */
export function checkVaultPath(relPath: string): string {
  const parts = relPath.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) throw new VaultError("Path escapes the vault", 400);
  if (parts.some((p) => p.startsWith("."))) throw new VaultError("Hidden files are not served", 400);
  return parts.join("/");
}

export function checkNotePath(notePath: string): string {
  if (!notePath.toLowerCase().endsWith(".md")) throw new VaultError("Only .md notes are supported", 400);
  return checkVaultPath(notePath);
}

/** `folder/Topic.md` → `Topic` */
export function titleOf(notePath: string): string {
  return (notePath.split("/").pop() ?? notePath).replace(/\.md$/i, "");
}
