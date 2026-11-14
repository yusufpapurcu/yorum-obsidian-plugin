import { ACTIONS, AUTO_LENS, type ActionId, type ActionSpec, detectLens, isAction } from "./actions.js";
import { buildIntentSuggestionMessages, buildMessages, parseIntentSuggestions } from "./prompt.js";
import { parseSidecar, previousSidecarPathsFor, serializeSidecar, sidecarPathFor } from "./sidecar.js";
import type {
  Anchor,
  Block,
  ChatMessage,
  DeltaHandler,
  LlmClient,
  Message,
  Sidecar,
  Source,
  Thread,
} from "./types.js";
import { LlmError } from "./errors.js";
import { type RelatedNote, VaultIndex } from "./connections.js";
import { type SearchHit, searchVault } from "./search.js";
import { parseNote } from "./note.js";
import { type NoteStore, VaultError, type VaultListing, checkNotePath, titleOf } from "./store.js";

export interface NoteView {
  path: string;
  title: string;
  markdown: string;
  properties: Record<string, string[]> | null;
  blocks: Block[];
  sidecar: Sidecar;
}

/** Live progress for a streamed answer. */
export interface AnswerHooks {
  /** Which vault notes the AI is about to read, before the model starts. */
  onContext?: (related: RelatedNote[]) => void;
  /** Answer text as it is generated. */
  onDelta?: DeltaHandler;
}

export interface AskInput {
  anchor: Anchor | null;
  question?: string;
  action?: string;
  lens?: string;
}

export interface ReplyInput {
  content?: string;
  action?: string;
}

const MAX_QUOTE = 4000;
const MAX_TEXT = 8000;

/**
 * The commentary layer: reads notes (never writes them) and keeps intent + threads in sidecars.
 * Independent of HTTP so an Obsidian plugin can reuse it later.
 */
export class CommentaryService<S extends NoteStore = NoteStore> {
  /** Serializes read-modify-write of each sidecar. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly index: VaultIndex;

  constructor(
    readonly store: S,
    private readonly llm: LlmClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.index = new VaultIndex(store);
  }

  /** Notes and attachments, plus how many comment threads each note has. */
  async listing(): Promise<VaultListing & { commentCounts: Record<string, number> }> {
    const listing = await this.store.scan();
    const sidecars = await Promise.all(listing.notes.map((p) => this.loadSidecar(p)));
    const commentCounts: Record<string, number> = {};
    listing.notes.forEach((p, i) => {
      if (sidecars[i].threads.length) commentCounts[p] = sidecars[i].threads.length;
    });
    return { ...listing, commentCounts };
  }

  /** Search note titles, note text and AI comments across the vault. */
  async search(query: string): Promise<SearchHit[]> {
    const docs = await this.index.documents();
    const withComments = await Promise.all(
      docs.map(async (d) => ({ ...d, sidecar: await this.loadSidecar(d.path) })),
    );
    return searchVault(withComments, query);
  }

  async getNote(notePath: string): Promise<NoteView> {
    const markdown = await this.readNote(notePath);
    return {
      path: notePath,
      title: titleOf(notePath),
      markdown,
      ...parseNote(markdown),
      sidecar: await this.loadSidecar(notePath),
    };
  }

  async setIntent(notePath: string, intent: string): Promise<Sidecar> {
    if (typeof intent !== "string" || intent.length > MAX_TEXT) {
      throw new VaultError("Intent must be a string up to 8000 characters", 400);
    }
    await this.readNote(notePath); // 404 for unknown notes
    return this.update(notePath, (sidecar) => {
      sidecar.intent = intent;
    });
  }

  /** Three intents tailored to the note, for one-click setup of the per-note system prompt. */
  async suggestIntents(notePath: string): Promise<string[]> {
    const markdown = await this.readNote(notePath);
    const reply = await this.llm.complete(buildIntentSuggestionMessages(titleOf(notePath), markdown), { fast: true });
    const suggestions = parseIntentSuggestions(reply.content);
    if (!suggestions.length) throw new LlmError("The model returned no intent suggestions");
    return suggestions;
  }

  /**
   * Start a new thread anchored to a passage (or the whole note) and get the AI's comment.
   * The request is a typed question, a quick action, a concept lens, or a question with a lens.
   */
  async ask(notePath: string, input: AskInput, hooks: AnswerHooks = {}): Promise<Thread> {
    const markdown = await this.readNote(notePath);
    const { thread, action, lens } = this.newThread(input, markdown);
    const sidecar = await this.loadSidecar(notePath);
    const { reply, related } = await this.answer(notePath, markdown, sidecar, thread, action, hooks);
    thread.messages.push(this.message("assistant", reply.content, { sources: reply.sources, related }));
    // "Surprise me" lenses keep the framework the model chose, so follow-ups stay in it.
    if (lens === AUTO_LENS) thread.lens = detectLens(reply.content) ?? AUTO_LENS;

    await this.update(notePath, (fresh) => {
      fresh.threads.push(thread);
    });
    return thread;
  }

  /** Follow up inside an existing thread: a typed reply (ask why, push back…) or a quick action. */
  async reply(notePath: string, threadId: string, input: ReplyInput, hooks: AnswerHooks = {}): Promise<Thread> {
    const markdown = await this.readNote(notePath);
    const sidecar = await this.loadSidecar(notePath);
    const { pending, userMessage, action } = this.pendingReply(sidecar, threadId, input);
    const { reply, related } = await this.answer(notePath, markdown, sidecar, pending, action, hooks);
    const assistantMessage = this.message("assistant", reply.content, { sources: reply.sources, related });

    let result: Thread | undefined;
    await this.update(notePath, (fresh) => {
      const target = fresh.threads.find((t) => t.id === threadId);
      if (!target) throw new VaultError(`Thread not found: ${threadId}`, 404);
      target.messages.push(userMessage, assistantMessage);
      result = target;
    });
    return result!;
  }

  /**
   * Exactly what would be sent to the model for a new question (no `threadId`) or a follow-up,
   * without sending it: the context inspector ("what the AI sees").
   */
  async preview(
    notePath: string,
    input: (AskInput & { threadId?: undefined }) | (ReplyInput & { threadId: string }),
  ): Promise<{ messages: ChatMessage[]; related: RelatedNote[]; fast: boolean }> {
    const markdown = await this.readNote(notePath);
    const sidecar = await this.loadSidecar(notePath);
    let thread: Thread;
    let action: ActionId | null;
    if (input.threadId !== undefined) ({ pending: thread, action } = this.pendingReply(sidecar, input.threadId, input));
    else ({ thread, action } = this.newThread(input, markdown));
    return this.context(notePath, markdown, sidecar, thread, action);
  }

  /** Validate a new-thread request and build the thread with its first (user) message. */
  private newThread(input: AskInput, markdown: string) {
    const lens = validateLens(input.lens);
    const action = validateAction(input.action);
    const question = input.question?.trim()
      ? requireText(input.question, "Question")
      : action
        ? ACTIONS[action].question
        : lens
          ? lens === AUTO_LENS
            ? "Connect this to a framework from another field."
            : `Explain this through ${lens}.`
          : requireText(input.question, "Question");
    const anchor = validateAnchor(input.anchor, parseNote(markdown).blocks.length);
    const thread: Thread = {
      id: crypto.randomUUID(),
      anchor,
      createdAt: this.timestamp(),
      messages: [this.message("user", question, { action })],
      ...(lens ? { lens } : {}),
    };
    return { thread, action, lens };
  }

  /** Validate a follow-up and build the thread as the model will see it, ending with the new message. */
  private pendingReply(sidecar: Sidecar, threadId: string, input: ReplyInput) {
    const action = validateAction(input.action);
    const content =
      !input.content?.trim() && action ? ACTIONS[action].question : requireText(input.content, "Reply");
    const existing = sidecar.threads.find((t) => t.id === threadId);
    if (!existing) throw new VaultError(`Thread not found: ${threadId}`, 404);
    const userMessage = this.message("user", content, { action });
    const pending: Thread = { ...existing, messages: [...existing.messages, userMessage] };
    return { pending, userMessage, action };
  }

  async deleteThread(notePath: string, threadId: string): Promise<Sidecar> {
    await this.readNote(notePath);
    return this.update(notePath, (sidecar) => {
      const before = sidecar.threads.length;
      sidecar.threads = sidecar.threads.filter((t) => t.id !== threadId);
      if (sidecar.threads.length === before) throw new VaultError(`Thread not found: ${threadId}`, 404);
    });
  }

  /** Vault context and the exact model request for a thread ending with the pending user message. */
  private async context(notePath: string, markdown: string, sidecar: Sidecar, thread: Thread, action: ActionId | null) {
    const lastQuestion = [...thread.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const related = await this.index.related(notePath, `${thread.anchor?.quote ?? ""} ${lastQuestion}`);
    const messages = buildMessages({ noteTitle: titleOf(notePath), noteText: markdown, sidecar, thread, related });
    const spec: ActionSpec | null = action ? ACTIONS[action] : null;
    return { messages, related, fast: spec?.fast ?? false };
  }

  /** Gather context, announce it (so the UI can show what is being read), then stream the answer. */
  private async answer(
    notePath: string,
    markdown: string,
    sidecar: Sidecar,
    thread: Thread,
    action: ActionId | null,
    hooks: AnswerHooks,
  ) {
    const { messages, related, fast } = await this.context(notePath, markdown, sidecar, thread, action);
    hooks.onContext?.(related);
    const reply = await this.llm.complete(messages, { onDelta: hooks.onDelta, fast });
    return { reply, related };
  }

  private readNote(notePath: string): Promise<string> {
    return this.store.readNote(checkNotePath(notePath));
  }

  private async loadSidecar(notePath: string): Promise<Sidecar> {
    const key = checkNotePath(notePath);
    const json = (await this.store.readData(sidecarPathFor(key))) ?? (await this.moveLegacySidecar(key));
    return parseSidecar(json);
  }

  /**
   * A sidecar from an earlier version (`.margin/` folder or next to the note) moved into the data
   * folder; its JSON, or null when there is none. Older copies left behind are removed.
   */
  private async moveLegacySidecar(notePath: string): Promise<string | null> {
    let json: string | null = null;
    const found: string[] = [];
    for (const previous of previousSidecarPathsFor(notePath)) {
      const text = await this.store.readData(previous);
      if (text === null) continue;
      json ??= text; // newest layout wins
      found.push(previous);
    }
    if (json === null) return null;
    // Write the new copy before removing old ones, so a failed write never loses data.
    await this.store.writeData(sidecarPathFor(notePath), json);
    for (const previous of found) await this.store.deleteData(previous);
    return json;
  }

  /** Move every sidecar from an earlier layout into the data folder; returns how many moved. */
  async migrateSidecars(): Promise<number> {
    const { notes } = await this.store.scan();
    let moved = 0;
    for (const notePath of notes) {
      if ((await this.store.readData(sidecarPathFor(notePath))) === null && (await this.moveLegacySidecar(notePath)) !== null) {
        moved++;
      }
    }
    return moved;
  }

  /**
   * A note was renamed or moved: its AI data follows it. If the target already has data (an
   * orphan left by a deleted note), the threads are merged rather than overwritten. Returns
   * whether there was anything to move.
   */
  async moveNoteData(fromPath: string, toPath: string): Promise<boolean> {
    const from = checkNotePath(fromPath);
    const to = checkNotePath(toPath);
    if (from === to) return false;
    return this.withLock(from, async () => {
      const source = (await this.store.readData(sidecarPathFor(from))) ?? (await this.moveLegacySidecar(from));
      if (source === null) return false;
      const existing = await this.store.readData(sidecarPathFor(to));
      let json = source;
      if (existing !== null) {
        const moved = parseSidecar(source);
        const target = parseSidecar(existing);
        const known = new Set(target.threads.map((t) => t.id));
        target.threads.push(...moved.threads.filter((t) => !known.has(t.id)));
        target.intent = target.intent.trim() ? target.intent : moved.intent;
        target.updatedAt = this.timestamp();
        json = serializeSidecar(target);
      }
      await this.store.writeData(sidecarPathFor(to), json);
      await this.store.deleteData(sidecarPathFor(from));
      return true;
    });
  }

  /** A note was deleted: remove its AI data too (only called when the user opted in). */
  async deleteNoteData(notePath: string): Promise<void> {
    const key = checkNotePath(notePath);
    await this.withLock(key, async () => {
      await this.store.deleteData(sidecarPathFor(key));
      for (const previous of previousSidecarPathsFor(key)) await this.store.deleteData(previous);
    });
  }

  /** Read-modify-write of a note's sidecar, serialized per note. */
  private update(notePath: string, mutate: (sidecar: Sidecar) => void): Promise<Sidecar> {
    const key = checkNotePath(notePath);
    return this.withLock(key, async () => {
      const sidecar = await this.loadSidecar(key);
      mutate(sidecar);
      sidecar.updatedAt = this.timestamp();
      await this.store.writeData(sidecarPathFor(key), serializeSidecar(sidecar));
      return sidecar;
    });
  }

  /** Run `fn` after every earlier operation on the same note's data has finished. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  private message(
    role: Message["role"],
    content: string,
    extras: { sources?: Source[]; related?: RelatedNote[]; action?: ActionId | null } = {},
  ): Message {
    const message: Message = { id: crypto.randomUUID(), role, content, createdAt: this.timestamp() };
    if (extras.sources?.length) message.sources = extras.sources;
    if (extras.related?.length) message.related = extras.related.map((n) => n.path);
    if (extras.action) message.action = extras.action;
    return message;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new VaultError(`${label} must not be empty`, 400);
  if (value.length > MAX_TEXT) throw new VaultError(`${label} is too long`, 400);
  return value.trim();
}

function validateAnchor(anchor: unknown, blockCount: number): Anchor | null {
  if (anchor === null || anchor === undefined) return null;
  const { blockIndex, quote } = anchor as Partial<Anchor>;
  if (!Number.isInteger(blockIndex) || blockIndex! < 0 || blockIndex! >= blockCount) {
    throw new VaultError("Anchor blockIndex is out of range", 400);
  }
  if (typeof quote !== "string" || !quote.trim() || quote.length > MAX_QUOTE) {
    throw new VaultError("Anchor quote must be a non-empty string up to 4000 characters", 400);
  }
  return { blockIndex: blockIndex!, quote: quote.trim() };
}

function validateAction(action: unknown): ActionId | null {
  if (action === undefined || action === null || action === "") return null;
  if (!isAction(action)) throw new VaultError(`Unknown action: ${String(action)}`, 400);
  return action;
}

function validateLens(lens: unknown): string | null {
  if (lens === undefined || lens === null) return null;
  if (typeof lens !== "string" || !lens.trim() || lens.length > 200) {
    throw new VaultError("Lens must be a non-empty string up to 200 characters", 400);
  }
  return lens.trim();
}
