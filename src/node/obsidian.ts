import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ObsidianVault {
  /** Vault name as Obsidian shows it (its folder name); used in `obsidian://open?vault=`. */
  name: string;
  /** Absolute vault folder. */
  path: string;
  /** Where the served folder sits inside the vault ("" when it is the vault itself). */
  subfolder: string;
}

/** Obsidian's own registry of known vaults (read-only). */
export function defaultObsidianConfigPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "obsidian", "obsidian.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "obsidian", "obsidian.json");
}

/**
 * The registered Obsidian vault that contains `folder`, or null when Obsidian doesn't know it
 * (then `obsidian://` links cannot work and the UI explains how to add the vault instead).
 */
export async function findObsidianVault(
  folder: string,
  configPath = defaultObsidianConfigPath(),
): Promise<ObsidianVault | null> {
  let config: { vaults?: Record<string, { path?: string }> };
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return null;
  }
  const target = path.resolve(folder);
  const matches = Object.values(config.vaults ?? {})
    .map((v) => v.path)
    .filter((p): p is string => typeof p === "string")
    .map((p) => path.resolve(p))
    .filter((p) => {
      const rel = path.relative(p, target);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    })
    // Nested vaults: the innermost one owns the folder.
    .sort((a, b) => b.length - a.length);
  if (!matches.length) return null;
  const vaultPath = matches[0];
  return {
    name: path.basename(vaultPath),
    path: vaultPath,
    subfolder: path.relative(vaultPath, target).split(path.sep).join("/"),
  };
}
