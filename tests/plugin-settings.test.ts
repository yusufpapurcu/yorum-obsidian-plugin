import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/settings.js";

function fakeSecrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getSecret: (id: string) => store.get(id) ?? null,
    setSecret: (id: string, secret: string) => void store.set(id, secret),
    listSecrets: () => [...store.keys()],
  };
}

describe("plugin settings: API key in Obsidian secret storage", () => {
  it("moves a plain-text key from data.json into secret storage and drops it from settings", () => {
    const secrets = fakeSecrets();
    const { settings, migrated } = loadSettings(
      { baseUrl: "https://gw/v1", apiKey: " sk-old ", model: "m", webSearch: false },
      secrets,
    );
    expect(migrated).toBe(true);
    expect(settings).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://gw/v1",
      model: "m",
      chatgptModel: "",
      webSearch: false,
      apiKeySecret: "yorum-api-key",
      deleteAiDataWithNote: false,
    });
    expect(JSON.stringify(settings)).not.toContain("sk-old");
    expect(secrets.store.get("yorum-api-key")).toBe("sk-old");
  });

  it("never overwrites a different secret that already uses the default ID", () => {
    const secrets = fakeSecrets({ "yorum-api-key": "someone-elses" });
    const { settings } = loadSettings({ apiKey: "sk-mine" }, secrets);
    expect(settings.apiKeySecret).toBe("yorum-api-key-2");
    expect(secrets.store.get("yorum-api-key")).toBe("someone-elses");
    expect(secrets.store.get("yorum-api-key-2")).toBe("sk-mine");
  });

  it("leaves already-migrated settings alone and only rewrites when needed", () => {
    const secrets = fakeSecrets({ "yorum-api-key": "sk" });
    expect(loadSettings({ model: "m", apiKeySecret: "yorum-api-key" }, secrets)).toEqual({
      settings: {
        provider: "openai-compatible",
        baseUrl: "",
        model: "m",
        chatgptModel: "",
        webSearch: true,
        apiKeySecret: "yorum-api-key",
        deleteAiDataWithNote: false,
      },
      migrated: false,
    });
    // An empty leftover key field is still removed from data.json.
    expect(loadSettings({ apiKey: "" }, secrets).migrated).toBe(true);
    expect(secrets.store.size).toBe(1);
  });
});
