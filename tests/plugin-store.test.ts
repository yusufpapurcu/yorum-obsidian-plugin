import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { ObsidianNoteStore } from "../obsidian-plugin/src/store.js";
import { CommentaryService } from "../src/core/commentary.js";
import type { ChatMessage, LlmClient, LlmReply } from "../src/core/types.js";

/** In-memory stand-in for the parts of Obsidian's vault API the store uses. */
function fakeApp(initial: Record<string, string>): { app: App; files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const folders = new Set<string>();
  const tfile = (path: string) => ({
    path,
    extension: path.split(".").pop() ?? "",
    stat: { mtime: files.get(path)!.length },
  });
  const hidden = (path: string) => path.split("/").some((p) => p.startsWith("."));
  const vault = {
    // Like Obsidian, the vault index doesn't include hidden folders.
    getFiles: () => [...files.keys()].filter((p) => !hidden(p)).map(tfile),
    getFileByPath: (path: string) => (files.has(path) && !hidden(path) ? tfile(path) : null),
    cachedRead: async (file: { path: string }) => files.get(file.path)!,
    adapter: {
      exists: async (path: string) => files.has(path) || folders.has(path),
      read: async (path: string) => files.get(path)!,
      // Like the real adapter, writing needs the parent folder to exist.
      write: async (path: string, data: string) => {
        const parent = path.split("/").slice(0, -1).join("/");
        if (parent && !folders.has(parent)) throw new Error(`ENOENT: ${parent}`);
        files.set(path, data);
      },
      mkdir: async (path: string) => void folders.add(path),
      remove: async (path: string) => void files.delete(path),
    },
  };
  return { app: { vault } as unknown as App, files };
}

class EchoLlm implements LlmClient {
  calls: ChatMessage[][] = [];
  async complete(messages: ChatMessage[]): Promise<LlmReply> {
    this.calls.push(messages);
    return { content: "A margin comment about the base case.", sources: [] };
  }
}

describe("Obsidian plugin store", () => {
  it("runs the same commentary service on Obsidian's vault API: sidecars, links, listing, search", async () => {
    const { app, files } = fakeApp({
      "Study/Recursion.md": "# Recursion\n\nEvery recursive function needs a base case.\n",
      "Study/Systems.md": "Links to [[Recursion]] and talks about feedback.",
      "attachments/pic.png": "png",
    });
    const llm = new EchoLlm();
    const service = new CommentaryService(new ObsidianNoteStore(app), llm);

    const thread = await service.ask("Study/Recursion.md", {
      anchor: { blockIndex: 1, quote: "needs a base case" },
      action: "explain",
    });

    // Sidecar in the hidden data folder (mirroring the note path), note untouched.
    expect(JSON.parse(files.get(".yorum/Study/Recursion.json")!).threads[0].id).toBe(thread.id);
    expect(files.get("Study/Recursion.md")).toBe("# Recursion\n\nEvery recursive function needs a base case.\n");
    // Vault connections work through the vault API (backlink from Systems).
    expect(thread.messages[1].related).toEqual(["Study/Systems.md"]);
    expect(llm.calls[0][0].content).toContain('<vault-note title="Systems" relation="linked from">');
    // Listing excludes sidecars; search reaches the AI comment.
    expect(await service.listing()).toEqual({
      notes: ["Study/Recursion.md", "Study/Systems.md"],
      files: ["attachments/pic.png"],
      commentCounts: { "Study/Recursion.md": 1 },
    });
    const [hit] = await service.search("margin comment");
    expect(hit).toMatchObject({ path: "Study/Recursion.md", comments: [{ threadId: thread.id, role: "assistant" }] });
    await expect(service.getNote("Study/Missing.md")).rejects.toMatchObject({ status: 404 });
  });
});

describe("Obsidian plugin store: sidecar migration", () => {
  it("moves an old sidecar next to the note into .yorum via the vault adapter", async () => {
    const { app, files } = fakeApp({
      "Study/Recursion.md": "# Recursion\n",
      "Study/Recursion.ai.json": JSON.stringify({ version: 1, intent: "Quiz me", threads: [] }),
    });
    const service = new CommentaryService(new ObsidianNoteStore(app), new EchoLlm());
    expect(await service.migrateSidecars()).toBe(1);
    expect(files.has("Study/Recursion.ai.json")).toBe(false);
    expect(JSON.parse(files.get(".yorum/Study/Recursion.json")!).intent).toBe("Quiz me");
    expect((await service.listing()).notes).toEqual(["Study/Recursion.md"]);
  });
});
