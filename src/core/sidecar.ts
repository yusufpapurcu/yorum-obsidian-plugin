import type { Sidecar } from "./types.js";

/**
 * AI data lives in one hidden folder at the vault root, mirroring note paths, so it stays out of
 * the file explorer and groups cleanly in git history:
 * `Study/Recursion.md` → `.yorum/Study/Recursion.json`.
 */
export const SIDECAR_DIR = ".yorum";

export function sidecarPathFor(notePath: string): string {
  return `${SIDECAR_DIR}/${notePath.replace(/\.md$/i, "")}.json`;
}

/** The note a sidecar belongs to, or null when the path is not a sidecar. */
export function notePathForSidecar(sidecarPath: string): string | null {
  const prefix = `${SIDECAR_DIR}/`;
  if (!sidecarPath.startsWith(prefix) || !sidecarPath.endsWith(".json")) return null;
  return `${sidecarPath.slice(prefix.length, -".json".length)}.md`;
}

/**
 * Where earlier versions kept a note's sidecar, newest first: the `.margin/` folder (before the
 * project was renamed to yorum), then next to the note (`Study/Recursion.ai.json`).
 */
export function previousSidecarPathsFor(notePath: string): string[] {
  const base = notePath.replace(/\.md$/i, "");
  return [`.margin/${base}.json`, `${base}.ai.json`];
}

export function emptySidecar(): Sidecar {
  return { version: 1, intent: "", threads: [], updatedAt: null };
}

/** Sidecar from stored JSON (null = the note has no sidecar yet); tolerant of missing fields. */
export function parseSidecar(json: string | null): Sidecar {
  if (json === null) return emptySidecar();
  const data = JSON.parse(json) as Partial<Sidecar>;
  return {
    version: 1,
    intent: typeof data.intent === "string" ? data.intent : "",
    threads: Array.isArray(data.threads) ? data.threads : [],
    updatedAt: data.updatedAt ?? null,
  };
}

export function serializeSidecar(sidecar: Sidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}
