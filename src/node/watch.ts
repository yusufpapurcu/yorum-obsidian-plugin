import { type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { notePathForSidecar } from "../core/sidecar.js";

/**
 * Live sync with Obsidian: the vault folder is watched so edits made in Obsidian (or any editor)
 * show up in the browser without a reload.
 */
export interface VaultChange {
  /** `note`: a .md file changed; `sidecar`: a note's AI commentary changed; `files`: anything else. */
  kind: "note" | "sidecar" | "files";
  /** Vault-relative path; for sidecars, the path of the note they belong to. */
  path: string;
  /** Created, deleted or renamed (the note list needs a refresh). */
  structural: boolean;
}

type Listener = (change: VaultChange) => void;

/** Fan-out of vault changes to connected browsers. */
export class VaultEvents {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change: VaultChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

/** Changes to one path within this window are reported once. */
export const DEBOUNCE_MS = 120;

/**
 * Watch `root` recursively and report changes, coalesced per path (editors write files in several
 * steps). Hidden folders (`.obsidian`, `.git`) and temp files are ignored — except the `.yorum`
 * data folder, whose files are reported as sidecar changes of their note.
 */
export function watchVault(root: string, onChange: Listener): FSWatcher {
  const pending = new Map<string, { timer: NodeJS.Timeout; structural: boolean }>();
  const watcher = watch(root, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const rel = filename.toString().split(path.sep).join("/");
    if (rel.includes(".tmp-")) return;
    const sidecarOf = notePathForSidecar(rel);
    if (!sidecarOf && rel.split("/").some((part) => part.startsWith("."))) return;
    const previous = pending.get(rel);
    if (previous) clearTimeout(previous.timer);
    const structural = (previous?.structural ?? false) || eventType === "rename";
    pending.set(rel, {
      structural,
      timer: setTimeout(() => {
        pending.delete(rel);
        if (sidecarOf) onChange({ kind: "sidecar", path: sidecarOf, structural: false });
        else if (rel.toLowerCase().endsWith(".md")) onChange({ kind: "note", path: rel, structural });
        else onChange({ kind: "files", path: rel, structural });
      }, DEBOUNCE_MS),
    });
  });
  return watcher;
}
