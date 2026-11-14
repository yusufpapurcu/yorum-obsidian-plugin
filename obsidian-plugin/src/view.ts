import { ItemView, MarkdownView, Notice, type TFile, type WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { ACTIONS, AUTO_LENS, type ActionId } from "../../src/core/actions.js";
import { toObsidianCallout } from "../../src/core/callout.js";
import type { NoteView } from "../../src/core/commentary.js";
import type { Anchor, Thread } from "../../src/core/types.js";
import type YorumPlugin from "./main.js";
import { DiagramModal, LensModal } from "./modals.js";
import { renderComment } from "./render.js";

export const VIEW_TYPE = "yorum-panel";

const GENERIC_INTENTS = [
  "Quiz me on this until I really understand it.",
  "Challenge my thinking; tell me where I'm wrong.",
  "Explain things like I'm new to this topic.",
  "Connect this to my other notes and to ideas from other fields.",
];

/** What a new-thread request asks for (one of these, or a lens with an optional question). */
export interface AskRequest {
  question?: string;
  action?: ActionId;
  lens?: string;
}

/**
 * The yorum panel: AI comment threads for the note open in the editor, stored in its sidecar
 * (`.yorum/<note>.json`). Follows the active note; refreshes when the note changes.
 */
export class YorumView extends ItemView {
  private file: TFile | null = null;
  private note: NoteView | null = null;
  private focusThreadId: string | null = null;
  private composer: { anchor: Anchor | null; lensOpen: boolean } | null = null;
  /** In-flight answer shown at the top of the panel (or inside its thread) while it streams. */
  private pending: { threadId: string | null; question: string; text: string; context: string } | null = null;
  /** Half-typed replies keyed by thread id; survive any re-render. */
  private readonly drafts = new Map<string, string>();
  private readonly reloadSoon = debounce(() => void this.reload(), 150, true);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: YorumPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Yorum";
  }

  getIcon(): string {
    return "message-square-quote";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("yorum-view");
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.followActive()));
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        // Sidecars live in the hidden .yorum folder, which Obsidian doesn't report; the panel
        // reloads on every note switch and after its own writes.
        if (!this.file || this.pending) return;
        if (f.path === this.file.path) this.reloadSoon();
      }),
    );
    // [[links]] inside AI comments open the note, like everywhere else in Obsidian; a diagram opens
    // full size (the panel is narrow).
    this.registerDomEvent(this.contentEl, "click", (event) => {
      const target = event.target as HTMLElement;
      const diagram = target.closest(".yorum-msg .mermaid, .yorum-msg .yorum-sketch-svg");
      if (diagram) {
        new DiagramModal(this.app, diagram).open();
        return;
      }
      const link = target.closest<HTMLAnchorElement>("a.internal-link");
      if (!link) return;
      event.preventDefault();
      void this.app.workspace.openLinkText(link.dataset.href ?? link.getAttr("href") ?? "", this.file?.path ?? "");
    });
    this.followActive();
  }

  /** Show the note in the most recently active Markdown editor. */
  private followActive(): void {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (file && file.path !== this.file?.path) void this.setFile(file);
    if (!this.file) this.render();
  }

  get currentPath(): string | null {
    return this.file?.path ?? null;
  }

  async setFile(file: TFile): Promise<void> {
    if (file.path === this.file?.path && this.note) return;
    this.file = file;
    this.focusThreadId = null;
    this.composer = null;
    await this.reload();
  }

  async reload(): Promise<void> {
    if (!this.file) return this.render();
    try {
      this.note = await this.plugin.service.getNote(this.file.path);
    } catch (err) {
      this.note = null;
      new Notice(`Yorum: ${(err as Error).message}`);
    }
    this.render();
    if (this.note) this.plugin.syncHighlights(this.note);
  }

  /* ---------- rendering ---------- */

  private render(): void {
    const root = this.contentEl;
    root.empty();
    if (!this.file || !this.note) {
      root.createDiv({ cls: "yorum-empty", text: "Open a note to talk with it." });
      return;
    }
    const note = this.note;
    const header = root.createDiv({ cls: "yorum-header" });
    header.createDiv({ cls: "yorum-title", text: note.title });
    const tools = header.createDiv({ cls: "yorum-tools" });
    this.iconButton(tools, "message-square-plus", "Ask about the whole note", () => this.openComposer(null));
    this.iconButton(tools, "search", "Search notes & AI comments", () => this.plugin.openSearch());

    this.renderIntent(root, note);
    if (this.pending && this.pending.threadId === null) this.renderPending(root.createDiv({ cls: "yorum-card pending" }));
    if (this.composer) this.renderComposer(root);

    const threads = [...note.sidecar.threads].sort(
      (a, b) => (a.anchor?.blockIndex ?? -1) - (b.anchor?.blockIndex ?? -1),
    );
    if (!threads.length && !this.composer && !this.pending) {
      root.createDiv({
        cls: "yorum-empty",
        text: "No comments yet. Select text in the note, then right-click → Yorum, or use the commands (Ctrl/Cmd+P → “Yorum”).",
      });
    }
    for (const thread of threads) this.renderThread(root, thread);
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const b = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.onclick = onClick;
    return b;
  }

  private renderIntent(root: HTMLElement, note: NoteView): void {
    const box = root.createDiv({ cls: "yorum-intent" });
    box.createDiv({ cls: "yorum-label", text: "Tell it what this note is for" });
    const input = box.createEl("textarea", { attr: { rows: "2", placeholder: "e.g. “Quiz me before Friday, explain with tiny examples.”" } });
    input.value = note.sidecar.intent;
    const row = box.createDiv({ cls: "yorum-row" });
    const state = row.createSpan({ cls: "yorum-muted" });
    const save = row.createEl("button", { text: "Save" });
    const starters = box.createDiv({ cls: "yorum-chips" });
    const apply = async (intent: string) => {
      input.value = intent;
      state.setText("saving…");
      note.sidecar = await this.plugin.service.setIntent(note.path, intent);
      state.setText("saved");
      starters.toggle(intent.trim() === "");
    };
    save.onclick = () => void apply(input.value);
    input.oninput = () => {
      state.setText(input.value === note.sidecar.intent ? "" : "unsaved");
      starters.toggle(input.value.trim() === "");
    };
    const suggest = starters.createEl("button", { cls: "yorum-chip accent", text: "✨ Suggest for this note" });
    suggest.onclick = async () => {
      suggest.disabled = true;
      suggest.setText("Reading your note…");
      try {
        const suggestions = await this.plugin.service.suggestIntents(note.path);
        starters.empty();
        for (const s of suggestions) starters.createEl("button", { cls: "yorum-chip accent", text: s }).onclick = () => void apply(s);
      } catch (err) {
        suggest.disabled = false;
        suggest.setText("✨ Suggest for this note");
        new Notice(`Yorum: ${(err as Error).message}`);
      }
    };
    for (const s of GENERIC_INTENTS) starters.createEl("button", { cls: "yorum-chip", text: s }).onclick = () => void apply(s);
    starters.toggle(note.sidecar.intent.trim() === "");
  }

  private renderComposer(root: HTMLElement): void {
    const { anchor, lensOpen } = this.composer!;
    const card = root.createDiv({ cls: "yorum-card composer" });
    if (anchor) card.createDiv({ cls: "yorum-quote", text: anchor.quote });
    const chips = card.createDiv({ cls: "yorum-chips" });
    for (const id of ["explain", "simplify", "challenge", "visualize"] as const) {
      chips.createEl("button", { cls: "yorum-chip", text: ACTIONS[id].label }).onclick = () => void this.send(anchor, { action: id });
    }
    let lens: string | null = null;
    const lensChip = chips.createEl("button", { cls: "yorum-chip", text: lensOpen ? "Lens…" : "Lens…" });
    lensChip.onclick = () =>
      new LensModal(this.app, (picked) => {
        lens = picked;
        lensChip.setText(`Lens: ${picked === AUTO_LENS ? "✨ surprise me" : picked}`);
        lensChip.addClass("selected");
        input.placeholder = "Optional: what should it explain through this lens?";
      }).open();
    const input = card.createEl("textarea", { attr: { rows: "2", placeholder: anchor ? "Ask about this passage…" : "Ask about the whole note…" } });
    const row = card.createDiv({ cls: "yorum-row" });
    row.createEl("button", { cls: "yorum-link", text: "What the AI sees" }).onclick = () =>
      void this.plugin.inspect(this.file!.path, { anchor, question: input.value.trim() || undefined, lens: lens ?? undefined });
    const right = row.createDiv();
    right.createEl("button", { text: "Cancel" }).onclick = () => {
      this.composer = null;
      this.render();
    };
    const ask = right.createEl("button", { cls: "mod-cta", text: "Ask" });
    const submit = () => {
      const question = input.value.trim();
      if (!question && !lens) return;
      void this.send(anchor, { question: question || undefined, lens: lens ?? undefined });
    };
    ask.onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
    };
    if (lensOpen) lensChip.click();
    else window.setTimeout(() => input.focus(), 0);
  }

  private renderPending(el: HTMLElement): void {
    const p = this.pending!;
    el.createDiv({ cls: "yorum-msg user", text: p.question });
    if (p.text) el.createDiv({ cls: "yorum-msg assistant streaming", text: p.text });
    else el.createDiv({ cls: "yorum-msg muted", text: p.context || "thinking…" });
  }

  private renderThread(root: HTMLElement, thread: Thread): void {
    const card = root.createDiv({ cls: "yorum-card", attr: { "data-thread": thread.id } });
    const focused = thread.id === this.focusThreadId;
    card.toggleClass("focus", focused);
    card.onclick = (e) => {
      if ((e.target as HTMLElement).closest("a, button, textarea, .yorum-steps")) return;
      if (!focused) this.focusThread(thread.id, true);
    };
    if (thread.lens) card.createDiv({ cls: "yorum-lens", text: `Lens · ${thread.lens === AUTO_LENS ? "another field" : thread.lens}` });
    if (thread.anchor) {
      const quote = card.createDiv({ cls: "yorum-quote", text: thread.anchor.quote, attr: { "aria-label": "Show in note" } });
      quote.onclick = () => this.plugin.revealPassage(this.note!.path, thread.anchor!.quote);
    } else {
      card.createDiv({ cls: "yorum-scope", text: "Whole note" });
    }
    const list = card.createDiv({ cls: "yorum-messages" });
    const shown = focused ? thread.messages : thread.messages.slice(-1);
    shown.forEach((m) => {
      const index = thread.messages.indexOf(m);
      const el = list.createDiv({ cls: `yorum-msg ${m.role}` });
      if (m.role === "user") {
        el.setText(m.content);
        return;
      }
      void renderComment(this.app, el, focused ? m : { content: m.content }, this.note!.path, this);
      if (!focused) return;
      const actions = list.createDiv({ cls: "yorum-row small" });
      const question = thread.messages.slice(0, index).findLast((x) => x.role === "user")?.content ?? "";
      const callout = () =>
        toObsidianCallout({
          question,
          answer: m.content,
          quote: thread.anchor?.quote,
          lens: thread.lens && thread.lens !== AUTO_LENS ? thread.lens : null,
          sources: m.sources ?? [],
          date: new Date(m.createdAt),
        });
      actions.createEl("button", { cls: "yorum-link", text: "Insert below passage" }).onclick = () =>
        this.plugin.insertBelow(this.note!.path, thread.anchor?.quote ?? null, callout());
      actions.createEl("button", { cls: "yorum-link", text: "Copy as callout" }).onclick = async () => {
        await navigator.clipboard.writeText(callout());
        new Notice("Copied as an Obsidian callout");
      };
    });
    if (!focused) {
      if (thread.messages.length > 2) card.createDiv({ cls: "yorum-muted", text: `${thread.messages.length / 2} exchanges — click to open` });
      return;
    }
    if (this.pending?.threadId === thread.id) this.renderPending(list);

    const followups = card.createDiv({ cls: "yorum-chips" });
    for (const id of ["angle", "visualize", "challenge", "simplify"] as const) {
      followups.createEl("button", { cls: "yorum-chip", text: ACTIONS[id].label }).onclick = () =>
        void this.reply(thread, { action: id });
    }
    const input = card.createEl("textarea", { attr: { rows: "2", placeholder: "Reply, ask why, push back…" } });
    input.value = this.drafts.get(thread.id) ?? "";
    input.oninput = () => this.drafts.set(thread.id, input.value);
    const row = card.createDiv({ cls: "yorum-row" });
    const left = row.createDiv();
    left.createEl("button", { cls: "yorum-link danger", text: "Delete" }).onclick = async () => {
      this.note!.sidecar = await this.plugin.service.deleteThread(this.note!.path, thread.id);
      this.render();
      this.plugin.syncHighlights(this.note!);
    };
    left.createEl("button", { cls: "yorum-link", text: "What the AI sees" }).onclick = () =>
      void this.plugin.inspect(this.note!.path, { threadId: thread.id, content: input.value.trim() || "(your reply)" });
    const send = () => {
      const content = input.value.trim();
      if (content) void this.reply(thread, { content });
    };
    row.createEl("button", { cls: "mod-cta", text: "Reply" }).onclick = send;
    input.onkeydown = (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
    };
  }

  /* ---------- actions ---------- */

  openComposer(anchor: Anchor | null, lensOpen = false): void {
    this.composer = { anchor, lensOpen };
    this.render();
  }

  focusThread(threadId: string, revealPassage: boolean): void {
    this.focusThreadId = threadId;
    this.render();
    this.contentEl.querySelector(`[data-thread="${threadId}"]`)?.scrollIntoView({ block: "nearest" });
    const anchor = this.note?.sidecar.threads.find((t) => t.id === threadId)?.anchor;
    if (revealPassage && anchor && this.note) this.plugin.revealPassage(this.note.path, anchor.quote);
  }

  /** Start a thread; the answer streams into the panel and lands in the sidecar. */
  async send(anchor: Anchor | null, request: AskRequest): Promise<void> {
    if (!this.note || this.pending) return;
    const notePath = this.note.path;
    const question =
      request.question ??
      (request.action ? ACTIONS[request.action].question : request.lens === AUTO_LENS ? "Connect this to a framework from another field." : `Explain this through ${request.lens}.`);
    this.composer = null;
    this.pending = { threadId: null, question, text: "", context: "" };
    this.render();
    try {
      const thread = await this.plugin.service.ask(notePath, { anchor, ...request }, this.streamHooks());
      this.pending = null;
      this.focusThreadId = thread.id;
      await this.reload();
      this.contentEl.querySelector(`[data-thread="${thread.id}"]`)?.scrollIntoView({ block: "nearest" });
    } catch (err) {
      this.pending = null;
      this.render();
      new Notice(`Yorum: ${(err as Error).message}`);
    }
  }

  private async reply(thread: Thread, input: { content?: string; action?: ActionId }): Promise<void> {
    if (!this.note || this.pending) return;
    const question = input.content ?? ACTIONS[input.action!].question;
    this.pending = { threadId: thread.id, question, text: "", context: "" };
    this.render();
    try {
      await this.plugin.service.reply(this.note.path, thread.id, input, this.streamHooks());
      this.drafts.delete(thread.id);
      this.pending = null;
      await this.reload();
    } catch (err) {
      this.pending = null;
      this.render();
      new Notice(`Yorum: ${(err as Error).message}`);
    }
  }

  /** Live progress: which vault notes are being read, then the answer as it streams. */
  private streamHooks() {
    let frame = 0;
    return {
      onContext: (related: { title: string }[]) => {
        if (!this.pending || !related.length) return;
        this.pending.context = `thinking with ${related.map((n) => n.title).join(", ")}…`;
        this.render();
      },
      onDelta: (text: string) => {
        if (!this.pending) return;
        this.pending.text += text;
        if (frame) return;
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          const live = this.contentEl.querySelector(".yorum-msg.streaming, .yorum-msg.muted");
          if (live && this.pending) {
            live.className = "yorum-msg assistant streaming";
            live.textContent = this.pending.text;
          } else {
            this.render();
          }
        });
      },
    };
  }
}
