import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentaryService } from "../src/core/commentary.js";
import { LlmError } from "../src/core/errors.js";
import { GeminiGroundedClient, groundedReply } from "../src/core/gemini.js";
import { OpenAICompatibleClient, createClient } from "../src/core/llm.js";
import { buildMessages } from "../src/core/prompt.js";
import { emptySidecar, parseSidecar, serializeSidecar, sidecarPathFor } from "../src/core/sidecar.js";
import type { ChatMessage, CompleteOptions, LlmClient, LlmReply, Sidecar, Source, Thread } from "../src/core/types.js";
import { ACTIONS, AUTO_LENS, detectLens } from "../src/core/actions.js";
import { VaultIndex } from "../src/core/connections.js";
import { blockIndexAt, parseNote } from "../src/core/note.js";
import { toObsidianCallout } from "../src/core/callout.js";
import { type SearchDocument, type Snippet, plainText, searchVault } from "../src/core/search.js";
import { FsNoteStore } from "./fs-store.js";

const NOTE = "Learning recursion.md";
const NOTE_TEXT = `# Learning recursion

A recursive function calls itself. I don't get how the answer comes back out.

## Base case

Every recursive function needs a base case.
`;

/** Records every request and answers with a numbered reply. */
class MockLlm implements LlmClient {
  calls: ChatMessage[][] = [];
  constructor(private readonly sources: Source[] = []) {}
  async complete(messages: ChatMessage[]): Promise<LlmReply> {
    this.calls.push(messages);
    return { content: `answer ${this.calls.length}`, sources: this.sources };
  }
}

class FailingLlm implements LlmClient {
  async complete(): Promise<LlmReply> {
    throw new LlmError("provider down");
  }
}

let dir: string;
let notePath: string;
const sha = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yorum-"));
  notePath = path.join(dir, NOTE);
  await writeFile(notePath, NOTE_TEXT);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The test note's sidecar as stored on disk. */
const savedSidecar = async () => parseSidecar(await new FsNoteStore(dir).readData(sidecarPathFor(NOTE)));

describe("sidecar", () => {
  it("returns an empty sidecar when none exists and round-trips what was saved", async () => {
    expect(await savedSidecar()).toEqual(emptySidecar());

    const sidecar: Sidecar = {
      version: 1,
      intent: "Quiz me before Friday",
      threads: [
        {
          id: "t1",
          anchor: { blockIndex: 1, quote: "calls itself" },
          createdAt: "2026-01-01T00:00:00.000Z",
          messages: [{ id: "m1", role: "user", content: "how?", createdAt: "2026-01-01T00:00:00.000Z" }],
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await new FsNoteStore(dir).writeData(sidecarPathFor(NOTE), serializeSidecar(sidecar));

    expect(sidecarPathFor("Study/Recursion.md")).toBe(".yorum/Study/Recursion.json");
    expect(await savedSidecar()).toEqual(sidecar);
    // Next to the note there is only the note: AI data lives in the hidden .yorum folder.
    expect((await readdir(dir)).sort()).toEqual([".yorum", NOTE]);
    expect(await readdir(path.join(dir, ".yorum"))).toEqual(["Learning recursion.json"]);
  });

  it("moves sidecars from older versions (next to the note) into .yorum, once", async () => {
    await mkdir(path.join(dir, "Study"));
    await writeFile(path.join(dir, "Study", "Deep.md"), "# Deep\n\nText.\n");
    const legacy = { version: 1, intent: "Quiz me", threads: [], updatedAt: null };
    await writeFile(path.join(dir, "Study", "Deep.ai.json"), JSON.stringify(legacy));
    await writeFile(path.join(dir, "Learning recursion.ai.json"), JSON.stringify({ ...legacy, intent: "Top level" }));
    const service = new CommentaryService(new FsNoteStore(dir), new MockLlm());

    expect(await service.migrateSidecars()).toBe(2);
    expect(await service.migrateSidecars()).toBe(0);
    expect((await readdir(dir)).sort()).toEqual([".yorum", NOTE, "Study"]);
    expect(await readdir(path.join(dir, "Study"))).toEqual(["Deep.md"]);
    expect((await service.getNote("Study/Deep.md")).sidecar.intent).toBe("Quiz me");
    expect((await savedSidecar()).intent).toBe("Top level");
  });

  it("migrates lazily too: reading a note picks up its old sidecar", async () => {
    await writeFile(path.join(dir, "Learning recursion.ai.json"), JSON.stringify({ version: 1, intent: "Old", threads: [] }));
    const service = new CommentaryService(new FsNoteStore(dir), new MockLlm());
    expect((await service.getNote(NOTE)).sidecar.intent).toBe("Old");
    expect((await readdir(dir)).sort()).toEqual([".yorum", NOTE]);
  });

  it("moves sidecars from the .margin folder (the project's name before yorum), newest layout winning", async () => {
    await mkdir(path.join(dir, ".margin", "Study"), { recursive: true });
    await mkdir(path.join(dir, "Study"));
    await writeFile(path.join(dir, "Study", "Deep.md"), "# Deep\n");
    await writeFile(path.join(dir, ".margin", "Study", "Deep.json"), JSON.stringify({ version: 1, intent: "From .margin", threads: [] }));
    // An even older copy next to the note is superseded and cleaned up.
    await writeFile(path.join(dir, "Study", "Deep.ai.json"), JSON.stringify({ version: 1, intent: "Oldest", threads: [] }));
    const service = new CommentaryService(new FsNoteStore(dir), new MockLlm());

    expect(await service.migrateSidecars()).toBe(1);
    expect((await service.getNote("Study/Deep.md")).sidecar.intent).toBe("From .margin");
    expect(await readdir(path.join(dir, ".margin", "Study"))).toEqual([]);
    expect(await readdir(path.join(dir, "Study"))).toEqual(["Deep.md"]);
  });
});

describe("CommentaryService", () => {
  it("never modifies the source note across intent, ask, reply and delete", async () => {
    const before = await sha(notePath);
    const service = new CommentaryService(new FsNoteStore(dir), new MockLlm());

    await service.setIntent(NOTE, "I'm struggling with recursion");
    const thread = await service.ask(NOTE, { anchor: { blockIndex: 1, quote: "calls itself" }, question: "Why?" });
    await service.reply(NOTE, thread.id, { content: "Still lost" });
    await service.ask(NOTE, { anchor: null, question: "Summarize my gaps" });
    await service.deleteThread(NOTE, thread.id);

    expect(await sha(notePath)).toBe(before);
  });

  it("stores an anchored thread with question and answer, and it survives a restart", async () => {
    const service = new CommentaryService(new FsNoteStore(dir), new MockLlm());
    await service.setIntent(NOTE, "Explain with tiny examples");
    const thread = await service.ask(NOTE, {
      anchor: { blockIndex: 1, quote: "how the answer comes back out" },
      question: "Walk me through it",
    });

    const restarted = new CommentaryService(new FsNoteStore(dir), new MockLlm());
    const view = await restarted.getNote(NOTE);
    expect(view.sidecar.intent).toBe("Explain with tiny examples");
    expect(view.sidecar.threads).toEqual([thread]);
    expect(thread.anchor).toEqual({ blockIndex: 1, quote: "how the answer comes back out" });
    expect(thread.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Walk me through it"],
      ["assistant", "answer 1"],
    ]);
  });

  it("appends follow-ups to the same thread and sends the whole history to the model", async () => {
    const llm = new MockLlm();
    const service = new CommentaryService(new FsNoteStore(dir), llm);
    const thread = await service.ask(NOTE, { anchor: { blockIndex: 2, quote: "Base case" }, question: "What is it?" });
    const updated = await service.reply(NOTE, thread.id, { content: "Why does it stop?" });

    expect(updated.id).toBe(thread.id);
    expect(updated.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "What is it?"],
      ["assistant", "answer 1"],
      ["user", "Why does it stop?"],
      ["assistant", "answer 2"],
    ]);
    expect(llm.calls[1].slice(1)).toEqual([
      { role: "user", content: "What is it?" },
      { role: "assistant", content: "answer 1" },
      { role: "user", content: "Why does it stop?" },
    ]);
    expect((await savedSidecar()).threads).toEqual([updated]);
  });

  it("keeps concurrent questions on the same note", async () => {
    const service = new CommentaryService(new FsNoteStore(dir), new MockLlm());
    await Promise.all(
      ["a", "b", "c"].map((question) => service.ask(NOTE, { anchor: null, question })),
    );
    const questions = (await savedSidecar()).threads.map((t) => t.messages[0].content).sort();
    expect(questions).toEqual(["a", "b", "c"]);
  });

  it("saves nothing when the model call fails", async () => {
    const service = new CommentaryService(new FsNoteStore(dir), new FailingLlm());
    await expect(service.ask(NOTE, { anchor: null, question: "hi" })).rejects.toThrow("provider down");
    expect((await readdir(dir)).sort()).toEqual([NOTE]);
  });

  it("rejects paths outside the vault, non-markdown files and bad anchors", async () => {
    await mkdir(path.join(dir, "vault"));
    await writeFile(path.join(dir, "vault", "a.md"), "inside");
    const service = new CommentaryService(new FsNoteStore(path.join(dir, "vault")), new MockLlm());

    await expect(service.getNote(`../${NOTE}`)).rejects.toMatchObject({ status: 400 });
    await expect(service.getNote("a.ai.json")).rejects.toMatchObject({ status: 400 });
    await expect(service.getNote("missing.md")).rejects.toMatchObject({ status: 404 });
    await expect(
      service.ask("a.md", { anchor: { blockIndex: 5, quote: "x" }, question: "q" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("buildMessages", () => {
  it("puts intent, current note text, other commentary and the anchor in the system prompt, then the thread", () => {
    const other: Thread = {
      id: "other",
      anchor: null,
      createdAt: "",
      messages: [
        { id: "1", role: "user", content: "Earlier question", createdAt: "" },
        { id: "2", role: "assistant", content: "Earlier answer", createdAt: "" },
      ],
    };
    const thread: Thread = {
      id: "current",
      anchor: { blockIndex: 1, quote: "calls itself" },
      createdAt: "",
      messages: [
        { id: "3", role: "user", content: "First", createdAt: "" },
        { id: "4", role: "assistant", content: "Reply", createdAt: "" },
        { id: "5", role: "user", content: "Second", createdAt: "" },
      ],
    };
    const sidecar: Sidecar = { version: 1, intent: "Quiz me before Friday", threads: [other, thread], updatedAt: null };

    const [system, ...history] = buildMessages({ noteTitle: "Learning recursion", noteText: NOTE_TEXT, sidecar, thread });

    expect(system.role).toBe("system");
    const order = ["Quiz me before Friday", NOTE_TEXT, "Earlier question", "Earlier answer", '"""\ncalls itself\n"""'].map(
      (part) => system.content.indexOf(part),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(history).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Reply" },
      { role: "user", content: "Second" },
    ]);
  });
});

describe("OpenAICompatibleClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["https://llm.example/v1", "https://llm.example/v1/chat/completions"],
    ["https://llm.example/v1/", "https://llm.example/v1/chat/completions"],
    ["https://llm.example/v1/chat/completions", "https://llm.example/v1/chat/completions"],
  ])("streams from the chat completions endpoint for base URL %s", async (baseUrl, expected) => {
    // Chunk boundaries fall mid-line, as they do on real networks.
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":" h"}}]}\n\nda',
        'ta: {"choices":[{"delta":{"content":"i "}}]}\n\ndata: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAICompatibleClient({ baseUrl, apiKey: "k", model: "m" });
    const deltas: string[] = [];

    expect(await client.complete([{ role: "user", content: "q" }], { onDelta: (d) => deltas.push(d) })).toEqual({
      content: "hi",
      sources: [],
    });
    expect(deltas).toEqual([" h", "i "]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(expected);
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "m", stream: true });
  });
});

describe("web search grounding", () => {
  afterEach(() => vi.unstubAllGlobals());

  const identity = async (url: string) => url;
  const chunk = (domain: string) => ({ web: { uri: `https://redirect/${domain}`, title: domain, domain } });

  it("numbers sources by first citation and links markers at UTF-8 byte offsets", async () => {
    // "é" and "→" are multi-byte: Gemini's segment indexes count bytes, not UTF-16 units.
    const text = "Café → first claim. Second claim.";
    const firstEnd = Buffer.byteLength("Café → first claim");
    const secondEnd = Buffer.byteLength("Café → first claim. Second claim");
    const reply = await groundedReply(
      text,
      {
        groundingChunks: [chunk("b.org"), chunk("a.org"), chunk("unused.org")],
        groundingSupports: [
          { segment: { endIndex: secondEnd }, groundingChunkIndices: [0] },
          { segment: { endIndex: firstEnd }, groundingChunkIndices: [1, 0] },
        ],
      },
      async (url) => url.replace("https://redirect/", "https://real.example/"),
    );

    expect(reply.sources).toEqual([
      { title: "a.org", url: "https://real.example/a.org" },
      { title: "b.org", url: "https://real.example/b.org" },
      { title: "unused.org", url: "https://real.example/unused.org" },
    ]);
    expect(reply.content).toBe(
      "Café → first claim[\\[1\\]](https://real.example/a.org)[\\[2\\]](https://real.example/b.org)." +
        " Second claim[\\[2\\]](https://real.example/b.org).",
    );
  });

  it("never puts a citation marker inside a fenced block or on its fence line", async () => {
    const text = "Intro claim.\n```mermaid\ngraph TD\nA-->B\n```\nDone.";
    const insideFence = Buffer.byteLength("Intro claim.\n```mermaid\ngraph TD");
    const atClosingFence = Buffer.byteLength("Intro claim.\n```mermaid\ngraph TD\nA-->B\n```");
    const reply = await groundedReply(
      text,
      {
        groundingChunks: [chunk("a.org")],
        groundingSupports: [
          { segment: { endIndex: Buffer.byteLength("Intro claim") }, groundingChunkIndices: [0] },
          { segment: { endIndex: insideFence }, groundingChunkIndices: [0] },
          { segment: { endIndex: atClosingFence }, groundingChunkIndices: [0] },
        ],
      },
      identity,
    );
    expect(reply.content).toBe("Intro claim[\\[1\\]](https://redirect/a.org).\n```mermaid\ngraph TD\nA-->B\n```\nDone.");
  });

  it("returns plain text and no sources when the model did not search", async () => {
    expect(await groundedReply(" Just an answer. ", undefined, identity)).toEqual({
      content: "Just an answer.",
      sources: [],
    });
  });

  it("streams a native Gemini request with Google Search enabled, maps roles and cites at the end", async () => {
    const event = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
    const fetchMock = vi.fn(async () =>
      sseResponse([
        event({ candidates: [{ content: { parts: [{ text: "planning", thought: true }, { text: "Python 3.15" }] } }] }),
        event({ candidates: [{ content: { parts: [{ text: " is out." }] } }] }),
        event({
          candidates: [
            {
              content: { parts: [{ text: "" }] },
              finishReason: "STOP",
              groundingMetadata: {
                groundingChunks: [chunk("python.org")],
                groundingSupports: [{ segment: { endIndex: 11 }, groundingChunkIndices: [0] }],
              },
            },
          ],
        }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiGroundedClient(
      { baseUrl: "https://gw.example/v1beta/", apiKey: "k", model: "google/gemini-x" },
      identity,
    );
    const deltas: string[] = [];

    const reply = await client.complete(
      [
        { role: "system", content: "Be a margin." },
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2" },
      ],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(deltas).toEqual(["Python 3.15", " is out."]);
    expect(reply).toEqual({
      content: "Python 3.15[\\[1\\]](https://redirect/python.org) is out.",
      sources: [{ title: "python.org", url: "https://redirect/python.org" }],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example/v1beta/models/google/gemini-x:streamGenerateContent?alt=sse");
    expect(JSON.parse(init.body as string)).toEqual({
      systemInstruction: { parts: [{ text: "Be a margin." }] },
      contents: [
        { role: "user", parts: [{ text: "Q1" }] },
        { role: "model", parts: [{ text: "A1" }] },
        { role: "user", parts: [{ text: "Q2" }] },
      ],
      tools: [{ googleSearch: {} }],
    });
  });

  it("uses grounding for Gemini models only when web search is on", () => {
    const base = { baseUrl: "https://gw.example/v1/chat/completions", apiKey: "k" };
    expect(createClient({ ...base, model: "google/gemini-x", webSearch: true })).toMatchObject({
      webSearch: true,
      endpoint: "gw.example",
    });
    expect(createClient({ ...base, model: "google/gemini-x", webSearch: false })).toMatchObject({ webSearch: false });
    expect(createClient({ ...base, model: "openai/gpt-x", webSearch: true })).toMatchObject({ webSearch: false });
  });

  it("stores sources on the assistant message", async () => {
    const sources = [{ title: "python.org", url: "https://www.python.org/downloads/" }];
    const service = new CommentaryService(new FsNoteStore(dir), new MockLlm(sources));
    const thread = await service.ask(NOTE, { anchor: null, question: "Latest Python?" });

    const saved = (await savedSidecar()).threads[0];
    expect(saved.messages[1].sources).toEqual(sources);
    expect(saved.messages[0].sources).toBeUndefined();
    expect(saved).toEqual(thread);
  });
});

describe("Obsidian vault support", () => {
  it("reads frontmatter as properties and keeps it out of the anchorable blocks", () => {
    const parsed = parseNote(
      "---\ntags: [a, b]\nstatus: draft\naliases:\n  - One\n  - \"Two\"\n---\n# Title\n\nBody text.\n",
    );
    expect(parsed.properties).toEqual({ tags: ["a", "b"], status: ["draft"], aliases: ["One", "Two"] });
    expect(parsed.blocks.map((b) => [b.index, b.type])).toEqual([
      [0, "heading"],
      [1, "paragraph"],
    ]);
    expect(parseNote("No frontmatter\n").properties).toBeNull();
  });

});

describe("vault connections", () => {
  const write = (name: string, text: string) => writeFile(path.join(dir, name), text);

  it("ranks explicit links first, then topical similarity, and leaves unrelated notes out", async () => {
    await write("Systems.md", "# Systems\nThe adaptive cycle: exploitation, conservation, release, reorganization. See [[Learning recursion]].");
    await write("Linked from here.md", "Some unrelated words about gardening tomatoes.");
    await write(
      "Cycles.md",
      "Resilience and the adaptive cycle of release and reorganization in forests: after a fire, pioneer species grow fast and the forest slowly rebuilds its stored capital.",
    );
    await write("Cooking.md", "Pasta needs salted water and patience.");
    // Shares words with the question but is only a title-sized stub: not a real topical match.
    await write("Release cycle.md", "adaptive cycle release");
    await writeFile(notePath, `${NOTE_TEXT}\nAlso [[Linked from here]].\nWhat about the adaptive cycle and release?\n`);

    const related = await new VaultIndex(new FsNoteStore(dir)).related(NOTE, "adaptive cycle release");
    expect(related.map((r) => [r.title, r.relation])).toEqual([
      ["Systems", "linked from"],
      ["Linked from here", "links to"],
      ["Cycles", "similar"],
    ]);
  });

  it("re-reads a note after it changes on disk", async () => {
    const index = new VaultIndex(new FsNoteStore(dir));
    await write("Other.md", "Pasta and tomatoes.");
    expect(await index.related(NOTE, "recursion base case")).toEqual([]);
    await write(
      "Other.md",
      "Recursion needs a base case, and a recursive function calls itself until the base case stops it; every call waits for the smaller one.",
    );
    await utimes(path.join(dir, "Other.md"), new Date(), new Date(Date.now() + 5000));
    expect((await index.related(NOTE, "recursion base case")).map((r) => r.title)).toEqual(["Other"]);
  });

  it("gives related notes to the model and records them on the answer", async () => {
    await write("Systems.md", "Base case thinking in systems. Links back to [[Learning recursion]].");
    const llm = new MockLlm();
    const service = new CommentaryService(new FsNoteStore(dir), llm);
    const thread = await service.ask(NOTE, { anchor: null, question: "Does this connect to my other notes?" });

    expect(llm.calls[0][0].content).toContain('<vault-note title="Systems" relation="linked from">');
    expect(llm.calls[0][0].content).toContain("[[Note title]]");
    expect(thread.messages[1].related).toEqual(["Systems.md"]);
  });
});

describe("quick actions and concept lenses", () => {
  it("turns a quick action into a readable question plus a one-turn instruction", async () => {
    const llm = new MockLlm();
    const service = new CommentaryService(new FsNoteStore(dir), llm);
    const thread = await service.ask(NOTE, { anchor: { blockIndex: 1, quote: "calls itself" }, action: "challenge" });
    expect(thread.messages[0]).toMatchObject({ role: "user", content: "Where could I be wrong here?", action: "challenge" });
    expect(llm.calls[0][0].content).toContain(`For this request: ${ACTIONS.challenge.instruction}`);

    // The instruction applies to that turn only; a typed follow-up gets none.
    await service.reply(NOTE, thread.id, { content: "Fair. And then?" });
    expect(llm.calls[1][0].content).not.toContain("For this request:");
    const visual = await service.reply(NOTE, thread.id, { action: "angle" });
    expect(visual.messages.at(-2)).toMatchObject({ content: "Show me another angle on this.", action: "angle" });
    expect(llm.calls[2][0].content).toContain(ACTIONS.angle.instruction);

    await expect(service.ask(NOTE, { anchor: null, action: "nope" })).rejects.toMatchObject({ status: 400 });
  });

  it("keeps the framework a 'surprise me' lens picked for the rest of the thread", async () => {
    const llm: LlmClient & { calls: ChatMessage[][] } = {
      calls: [],
      async complete(messages) {
        this.calls.push(messages);
        return { content: "**Lens:** C.S. Holling's Adaptive Cycle\n\nYour states map onto r, K, Ω, α.", sources: [] };
      },
    };
    const service = new CommentaryService(new FsNoteStore(dir), llm);
    const thread = await service.ask(NOTE, { anchor: null, lens: AUTO_LENS });

    expect(thread.messages[0].content).toBe("Connect this to a framework from another field.");
    expect(llm.calls[0][0].content).toContain("framework from a clearly different field");
    expect(llm.calls[0][0].content).toContain("where the analogy breaks");
    expect(thread.lens).toBe("C.S. Holling's Adaptive Cycle");

    await service.reply(NOTE, thread.id, { content: "Where am I now?" });
    expect(llm.calls[1][0].content).toContain("through the lens of C.S. Holling's Adaptive Cycle");
    expect((await savedSidecar()).threads[0].lens).toBe("C.S. Holling's Adaptive Cycle");
  });

  it("detects the announced lens line", () => {
    expect(detectLens("**Lens:** Game theory.\n\nText")).toBe("Game theory");
    expect(detectLens("No lens here")).toBeNull();
  });
});

describe("intent starters", () => {
  it("asks the model for three intents about this note and cleans the list", async () => {
    const llm: LlmClient & { calls: ChatMessage[][] } = {
      calls: [],
      async complete(messages) {
        this.calls.push(messages);
        return { content: '1. Quiz me before Friday\n- "Challenge my reasoning"\n\n• Connect this to my notes\n4) Extra', sources: [] };
      },
    };
    const service = new CommentaryService(new FsNoteStore(dir), llm);

    expect(await service.suggestIntents(NOTE)).toEqual([
      "Quiz me before Friday",
      "Challenge my reasoning",
      "Connect this to my notes",
    ]);
    expect(llm.calls[0][1].content).toContain(NOTE_TEXT);
    expect(llm.calls[0][0].content).toContain("in the note's language");
  });
});

/** A fetch Response whose body streams the given raw text chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("streaming", () => {
  it("announces vault context, streams text deltas, then saves the thread", async () => {
    await writeFile(path.join(dir, "Systems.md"), "Links back to [[Learning recursion]] and its base case.");
    const streaming: LlmClient = {
      async complete(_messages, opts = {}) {
        opts.onDelta?.("Hel");
        opts.onDelta?.("lo.");
        return { content: "Hello.", sources: [] };
      },
    };
    const events: unknown[] = [];
    const thread = await new CommentaryService(new FsNoteStore(dir), streaming).ask(
      NOTE,
      { anchor: null, question: "Hi?" },
      {
        onContext: (related) => events.push({ context: related.map((n) => [n.path, n.relation]) }),
        onDelta: (text) => events.push({ delta: text }),
      },
    );
    expect(events).toEqual([{ context: [["Systems.md", "linked from"]] }, { delta: "Hel" }, { delta: "lo." }]);
    expect(thread.messages.map((m) => m.content)).toEqual(["Hi?", "Hello."]);
    expect((await savedSidecar()).threads).toEqual([thread]);
  });

  it("uses the fast thinking level only for plain explanations", async () => {
    const options: CompleteOptions[] = [];
    const llm: LlmClient = {
      async complete(_messages, opts = {}) {
        options.push(opts);
        return { content: "ok", sources: [] };
      },
    };
    const service = new CommentaryService(new FsNoteStore(dir), llm);
    await service.ask(NOTE, { anchor: null, action: "explain" });
    await service.ask(NOTE, { anchor: null, action: "challenge" });
    await service.ask(NOTE, { anchor: null, question: "Typed question?" });
    expect(options.map((o) => o.fast)).toEqual([true, false, false]);
  });

  it("asks Gemini for the low thinking level in fast mode", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })}\n\n`]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiGroundedClient({ baseUrl: "https://gw.example/v1beta", apiKey: "k", model: "g" }, async (u) => u);
    await client.complete([{ role: "user", content: "q" }], { fast: true });
    await client.complete([{ role: "user", content: "q" }]);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0].generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "low" } });
    expect(bodies[1].generationConfig).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("context inspector", () => {
  it("previews exactly the request the model then receives, without saving anything", async () => {
    await writeFile(path.join(dir, "Systems.md"), "Links back to [[Learning recursion]] and its base case.");
    const llm = new MockLlm();
    const service = new CommentaryService(new FsNoteStore(dir), llm);
    const input = { anchor: { blockIndex: 1, quote: "calls itself" }, question: "Why?", lens: "Game theory" };

    const preview = await service.preview(NOTE, input);
    expect(await readdir(dir)).not.toContain(".yorum");
    const thread = await service.ask(NOTE, input);
    expect(llm.calls[0]).toEqual(preview.messages);
    expect(preview.related.map((n) => n.title)).toEqual(["Systems"]);

    const followUp = await service.preview(NOTE, { threadId: thread.id, action: "visualize" });
    await service.reply(NOTE, thread.id, { action: "visualize" });
    expect(llm.calls[1]).toEqual(followUp.messages);
  });

});

describe("copy as Obsidian callout", () => {
  it("prefixes every line, keeps Mermaid fenced, unwraps svg sketches and lists sources", () => {
    const md = toObsidianCallout({
      quote: "Fatigue always\n  seems to come",
      question: "Explain this through C.S. Holling's Adaptive Cycle.",
      lens: "C.S. Holling's Adaptive Cycle",
      answer: [
        "**Lens:** C.S. Holling's Adaptive Cycle",
        "",
        "```mermaid",
        "flowchart LR",
        "  r --> K",
        "```",
        "",
        "```svg",
        '<svg viewBox="0 0 10 10">',
        "",
        '  <g data-step="1"><circle r="2"/></g>',
        "</svg>",
        "```",
        "See [[On states]].",
      ].join("\n"),
      sources: [{ title: "python.org", url: "https://www.python.org/" }],
      date: new Date("2026-11-13T10:00:00Z"),
    });
    expect(md).toBe(
      [
        "> [!ai]+ yorum · C.S. Holling's Adaptive Cycle · 2026-11-13",
        '> *On:* "Fatigue always seems to come"',
        ">",
        "> **Explain this through C.S. Holling's Adaptive Cycle.**",
        ">",
        "> **Lens:** C.S. Holling's Adaptive Cycle",
        ">",
        "> ```mermaid",
        "> flowchart LR",
        ">   r --> K",
        "> ```",
        ">",
        '> <svg viewBox="0 0 10 10">',
        '>   <g data-step="1"><circle r="2"/></g>',
        "> </svg>",
        "> See [[On states]].",
        ">",
        "> Sources:",
        "> 1. [python.org](https://www.python.org/)",
        "",
      ].join("\n"),
    );
  });

  it("rewrites stored [[1]](url) citations so Obsidian doesn't read them as wiki links", () => {
    const md = toObsidianCallout({
      question: "Q",
      answer: "Claim[[1]](https://a.example/x)[[2]](https://b.example/y), see [[Systems thinking]].",
      date: new Date("2026-11-13T10:00:00Z"),
    });
    expect(md).toContain("> Claim[\\[1\\]](https://a.example/x)[\\[2\\]](https://b.example/y), see [[Systems thinking]].");
  });
});

describe("search", () => {
  const doc = (path: string, body: string, comments: string[] = []): SearchDocument => ({
    path,
    title: path.replace(/\.md$/, ""),
    body,
    sidecar: {
      version: 1,
      intent: "",
      updatedAt: null,
      threads: comments.length
        ? [
            {
              id: `t-${path}`,
              anchor: null,
              createdAt: "",
              messages: comments.map((content, i) => ({
                id: `${i}`,
                role: i % 2 ? ("assistant" as const) : ("user" as const),
                content,
                createdAt: "",
              })),
            },
          ]
        : [],
    },
  });
  const marked = (s: Snippet) => s.highlights.map(([a, b]) => s.text.slice(a, b));

  it("ignores case, accents and Turkish dotless i, and highlights the original text", () => {
    const [hit] = searchVault([doc("Okuma.md", "Bu ÖZEL bir deneme notu. Kitabı dün bitirdim.")], "kitabi ozel");
    expect(hit.path).toBe("Okuma.md");
    expect(hit.snippets.flatMap(marked)).toEqual(["ÖZEL", "Kitabı"]);
  });

  it("finds words that only appear in the AI commentary and points at the thread", () => {
    const docs = [
      doc("Mental states.md", "Fatigue after productive stretches.", [
        "Explain this through a lens.",
        "**Lens:** C.S. Holling's Adaptive Cycle — flow is the K phase.",
      ]),
      doc("Cooking.md", "Pasta and salt."),
    ];
    const hits = searchVault(docs, "holling");
    expect(hits.map((h) => h.path)).toEqual(["Mental states.md"]);
    expect(hits[0].snippets).toEqual([]);
    expect(hits[0].comments).toHaveLength(1);
    expect(hits[0].comments[0]).toMatchObject({ threadId: "t-Mental states.md", role: "assistant" });
    expect(marked(hits[0].comments[0].snippet)).toEqual(["Holling"]);
  });

  it("requires every term somewhere in the note, ranks title matches first and skips sketch markup", () => {
    const docs = [
      doc("Recursion.md", "A function that calls itself."),
      doc("Notes.md", "Recursion appears here, and a base case too."),
      doc("Sketch.md", "Nothing here.", ["q", '```svg\n<svg><text>recursion base</text></svg>\n```']),
    ];
    expect(searchVault(docs, "recursion").map((h) => h.path)).toEqual(["Recursion.md", "Notes.md"]);
    expect(searchVault(docs, "recursion base").map((h) => h.path)).toEqual(["Notes.md"]);
    expect(searchVault(docs, " ")).toEqual([]);
  });
});

describe("search snippets", () => {
  it("show readable text, not Markdown or LaTeX", () => {
    expect(
      plainText(
        "## The adaptive cycle\n> [!note] Core idea\n> A **system** is *more* than [[On states|its parts]], see [docs](https://x.y).\n$$\nR = \\frac{a}{b}\n$$\nInline $K$ phase and `code`.",
      ).replace(/\s+/g, " ").trim(),
    ).toBe("The adaptive cycle Core idea A system is more than its parts, see docs. Inline K phase and code.");
  });

  it("keeps dollar amounts and the spacing between paragraphs", async () => {
    expect(plainText("Coffee costs $5 and lunch $10.")).toBe("Coffee costs $5 and lunch $10.");
    await writeFile(path.join(dir, "Other.md"), "First paragraph.\n\n$$\nx\n$$\n\n## Heading\n\nLast.");
    const docs = await new VaultIndex(new FsNoteStore(dir)).documents();
    expect(plainText(docs.find((d) => d.path === "Other.md")!.body).replace(/\s+/g, " ").trim()).toBe(
      "First paragraph. Heading Last.",
    );
  });
});

describe("anchors from an editor selection", () => {
  it("maps a character offset to the block index anchors use", () => {
    const md = "---\ntags: [a]\n---\n# Title\n\nFirst paragraph here.\n\n- item one\n- item two\n\nLast.";
    const at = (needle: string) => blockIndexAt(md, md.indexOf(needle));
    expect(parseNote(md).blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "paragraph"]);
    expect([at("Title"), at("paragraph here"), at("item two"), at("Last")]).toEqual([0, 1, 2, 3]);
    expect(at("tags")).toBeNull();
    // Between blocks (on the blank line) the selection belongs to the block before it.
    expect(blockIndexAt(md, md.indexOf("First") - 1)).toBe(0);
  });
});

describe("AI data follows its note", () => {
  const saved = (notePath: string) => new FsNoteStore(dir).readData(sidecarPathFor(notePath));

  it("moves a note's comments on rename/move and leaves the source empty", async () => {
    const service = new CommentaryService(new FsNoteStore(dir), new MockLlm());
    const thread = await service.ask(NOTE, { anchor: null, question: "Why?" });
    await mkdir(path.join(dir, "Archive"));
    await rename(notePath, path.join(dir, "Archive", "Recursion.md"));

    expect(await service.moveNoteData(NOTE, "Archive/Recursion.md")).toBe(true);
    expect(await saved(NOTE)).toBeNull();
    expect((await service.getNote("Archive/Recursion.md")).sidecar.threads.map((t) => t.id)).toEqual([thread.id]);
    // Nothing to move the second time (e.g. Obsidian reporting both a folder and its files).
    expect(await service.moveNoteData(NOTE, "Archive/Recursion.md")).toBe(false);
  });

  it("merges into an orphan already at the target instead of overwriting it", async () => {
    const store = new FsNoteStore(dir);
    const t = (id: string) => ({ id, anchor: null, createdAt: "", messages: [] });
    await store.writeData(sidecarPathFor("Old.md"), serializeSidecar({ version: 1, intent: "Moved intent", threads: [t("a"), t("b")], updatedAt: null }));
    await store.writeData(sidecarPathFor("New.md"), serializeSidecar({ version: 1, intent: "", threads: [t("b"), t("c")], updatedAt: null }));
    const service = new CommentaryService(store, new MockLlm());

    await service.moveNoteData("Old.md", "New.md");
    const merged = parseSidecar(await saved("New.md"));
    expect(merged.threads.map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(merged.intent).toBe("Moved intent");
    expect(await saved("Old.md")).toBeNull();
  });

  it("moves an old-style sidecar too, and deletes a note's data on request", async () => {
    await writeFile(path.join(dir, "Learning recursion.ai.json"), JSON.stringify({ version: 1, intent: "Legacy", threads: [] }));
    const service = new CommentaryService(new FsNoteStore(dir), new MockLlm());
    await service.moveNoteData(NOTE, "Renamed.md");
    expect(parseSidecar(await saved("Renamed.md")).intent).toBe("Legacy");
    expect(await readdir(dir)).not.toContain("Learning recursion.ai.json");

    await service.deleteNoteData("Renamed.md");
    expect(await saved("Renamed.md")).toBeNull();
  });
});
