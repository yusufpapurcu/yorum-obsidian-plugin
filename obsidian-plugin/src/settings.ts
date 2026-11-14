import type { SecretStorage } from "obsidian";

/**
 * Plugin settings as saved in `.obsidian/plugins/yorum/data.json`. The API key is NOT here:
 * it lives in Obsidian's secret storage (outside the vault), and data.json only names the
 * secret — so the file is safe to commit with obsidian-git.
 */
export interface YorumSettings {
  baseUrl: string;
  model: string;
  /** Gemini models: let the model search the web (Google grounding) and cite sources. */
  webSearch: boolean;
  /** ID of the secret in Obsidian's secret storage that holds the API key ("" = none chosen). */
  apiKeySecret: string;
  /** When a note is deleted, delete its AI comments too. Off by default: AI data is never removed silently. */
  deleteAiDataWithNote: boolean;
}

export const DEFAULT_SETTINGS: YorumSettings = {
  baseUrl: "",
  model: "",
  webSearch: true,
  apiKeySecret: "",
  deleteAiDataWithNote: false,
};
const DEFAULT_SECRET_ID = "yorum-api-key";

/**
 * Settings from data.json. Older versions stored the key in plain text (`apiKey`); it is moved
 * into secret storage — without overwriting an existing secret of the same ID — and dropped.
 * `migrated` tells the caller to rewrite data.json so the plain-text key is gone from disk.
 */
export function loadSettings(
  data: unknown,
  secrets: Pick<SecretStorage, "getSecret" | "setSecret" | "listSecrets">,
): { settings: YorumSettings; migrated: boolean } {
  const { apiKey, ...rest } = (data ?? {}) as Partial<YorumSettings> & { apiKey?: unknown };
  const settings: YorumSettings = { ...DEFAULT_SETTINGS, ...rest };
  if (typeof apiKey !== "string" || !apiKey.trim()) return { settings, migrated: apiKey !== undefined };

  const key = apiKey.trim();
  const taken = new Set(secrets.listSecrets());
  let id = DEFAULT_SECRET_ID;
  for (let n = 2; taken.has(id) && secrets.getSecret(id) !== key; n++) id = `${DEFAULT_SECRET_ID}-${n}`;
  if (secrets.getSecret(id) !== key) secrets.setSecret(id, key);
  return { settings: { ...settings, apiKeySecret: id }, migrated: true };
}
