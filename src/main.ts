import type { EditorView } from "@codemirror/view";
import {
  type App,
  type Editor,
  MarkdownView,
  type MarkdownFileInfo,
  Notice,
  Plugin,
  PluginSettingTab,
  Platform,
  SecretComponent,
  Setting,
  type TAbstractFile,
  TFile,
  TFolder,
  Vault,
  type WorkspaceLeaf,
} from "obsidian";
import { ACTIONS, type ActionId } from "./core/actions.js";
import { type AskInput, CommentaryService, type NoteView, type ReplyInput } from "./core/commentary.js";
import { CHATGPT_ENDPOINT, ChatGptClient, ChatGptSession, type ChatGptTokens, parseTokens } from "./core/chatgpt.js";
import { UnconfiguredClient, createClient } from "./core/llm.js";
import { blockIndexAt } from "./core/note.js";
import type { Anchor } from "./core/types.js";
import { anchorHighlights, findQuote, setAnchors } from "./highlights.js";
import { ChatGptSignInModal, InspectorModal, LensModal, SearchModal } from "./modals.js";
import { CHATGPT_SECRET_ID, type YorumSettings, DEFAULT_SETTINGS, loadSettings } from "./settings.js";
import { fetchWithoutCors } from "./chatgpt.js";
import { SIDECAR_DIR, sidecarPathFor } from "./core/sidecar.js";
import { ObsidianNoteStore } from "./store.js";
import { type AskRequest, YorumView, VIEW_TYPE } from "./view.js";

const SELECTION_ACTIONS: ActionId[] = ["explain", "simplify", "challenge", "visualize"];

export default class YorumPlugin extends Plugin {
  settings: YorumSettings = { ...DEFAULT_SETTINGS };
  service!: CommentaryService;
  private llmInfo: { model: string | null; webSearch: boolean; endpoint: string | null } = {
    model: null,
    webSearch: false,
    endpoint: null,
  };

  async onload(): Promise<void> {
    const { settings, migrated } = loadSettings(await this.loadData(), this.app.secretStorage);
    this.settings = settings;
    // Rewrite data.json so a plain-text key from an older version is gone from disk.
    if (migrated) await this.saveData(this.settings);
    this.rebuildService();
    // Earlier versions kept sidecars next to notes; move them into .yorum/ once the vault is indexed.
    this.app.workspace.onLayoutReady(async () => {
      const moved = await this.service.migrateSidecars();
      if (moved) new Notice(`Yorum: moved ${moved} AI comment file(s) into .yorum/`);
    });
    // AI data follows its note: renames and moves (of notes or whole folders) move it along;
    // deleting a note deletes it only when the user turned that on.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("delete", (file) => void this.onDelete(file)));
    this.registerView(VIEW_TYPE, (leaf) => new YorumView(leaf, this));
    this.registerEditorExtension(anchorHighlights((threadId) => void this.focusThread(threadId)));
    this.addRibbonIcon("message-square-quote", "Open Yorum", () => void this.activateView());
    this.addSettingTab(new YorumSettingTab(this.app, this));

    this.addCommand({ id: "open-panel", name: "Open panel", callback: () => void this.activateView() });
    this.addCommand({ id: "search", name: "Search notes & AI comments", callback: () => this.openSearch() });
    this.addCommand({
      id: "ask-note",
      name: "Ask about this note",
      editorCallback: async (_editor, ctx) => {
        const view = await this.viewFor(ctx);
        view?.openComposer(null);
      },
    });
    this.addCommand({
      id: "ask-selection",
      name: "Ask about selection…",
      editorCheckCallback: (checking, editor, ctx) => this.selectionCommand(checking, editor, ctx, null),
    });
    for (const id of SELECTION_ACTIONS) {
      this.addCommand({
        id: `${id}-selection`,
        name: `${ACTIONS[id].label}: selection`,
        editorCheckCallback: (checking, editor, ctx) => this.selectionCommand(checking, editor, ctx, { action: id }),
      });
    }
    this.addCommand({
      id: "lens-selection",
      name: "Explain selection through a lens…",
      editorCheckCallback: (checking, editor, ctx) => this.selectionCommand(checking, editor, ctx, "lens"),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, ctx) => {
        if (!editor.somethingSelected()) return;
        const add = (title: string, request: AskRequest | "lens" | null) =>
          menu.addItem((item) =>
            item
              .setSection("yorum")
              .setTitle(`Yorum: ${title}`)
              .setIcon("message-square-quote")
              .onClick(() => void this.askAboutSelection(editor, ctx, request)),
          );
        add("Ask…", null);
        for (const id of SELECTION_ACTIONS) add(ACTIONS[id].label, { action: id });
        add("Lens…", "lens");
      }),
    );
  }

  /* ---------- AI data follows notes ---------- */

  private async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
    const moves: [string, string][] = [];
    if (file instanceof TFile && file.extension === "md" && oldPath.toLowerCase().endsWith(".md")) {
      moves.push([oldPath, file.path]);
    } else if (file instanceof TFolder) {
      // Obsidian may or may not also report each child; moving is idempotent either way.
      Vault.recurseChildren(file, (child) => {
        if (child instanceof TFile && child.extension === "md") {
          moves.push([`${oldPath}/${child.path.slice(file.path.length + 1)}`, child.path]);
        }
      });
    }
    try {
      for (const [from, to] of moves) await this.service.moveNoteData(from, to);
      if (moves.length) {
        await this.pruneDataFolders(file instanceof TFolder ? `${SIDECAR_DIR}/${oldPath}` : parentOf(sidecarPathFor(oldPath)));
        await this.refreshPanel();
      }
    } catch (err) {
      new Notice(`Yorum: couldn't move AI comments for ${oldPath}: ${(err as Error).message}`);
    }
  }

  private async onDelete(file: TAbstractFile): Promise<void> {
    if (!this.settings.deleteAiDataWithNote) return;
    try {
      if (file instanceof TFile && file.extension === "md") {
        await this.service.deleteNoteData(file.path);
        await this.pruneDataFolders(parentOf(sidecarPathFor(file.path)));
      } else if (file instanceof TFolder) {
        const dir = `${SIDECAR_DIR}/${file.path}`;
        if (await this.app.vault.adapter.exists(dir)) await this.app.vault.adapter.rmdir(dir, true);
        await this.pruneDataFolders(parentOf(dir));
      }
    } catch (err) {
      new Notice(`Yorum: couldn't delete AI comments for ${file.path}: ${(err as Error).message}`);
    }
  }

  /** Remove `dir` and its parents inside .yorum while they are empty (no clutter after moves). */
  private async pruneDataFolders(dir: string): Promise<void> {
    const { adapter } = this.app.vault;
    const isEmpty = async (d: string): Promise<boolean> => {
      const { files, folders } = await adapter.list(d);
      for (const f of folders) if (!(await isEmpty(f))) return false;
      return files.length === 0;
    };
    for (let d = dir; d.startsWith(`${SIDECAR_DIR}/`); d = parentOf(d)) {
      if (!(await adapter.exists(d))) continue;
      if (!(await isEmpty(d))) return;
      await adapter.rmdir(d, true);
    }
  }

  private async refreshPanel(): Promise<void> {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof YorumView) await view.reload();
  }

  /**
   * (Re)create the model client from settings; called on load and whenever settings change.
   * Credentials are read from Obsidian's secret storage, never from data.json.
   */
  rebuildService(): void {
    const store = new ObsidianNoteStore(this.app);
    const unconfigured = (missing: (string | false)[]) => {
      const names = missing.filter((m): m is string => Boolean(m));
      if (!names.length) return false;
      this.service = new CommentaryService(store, new UnconfiguredClient(names));
      this.llmInfo = { model: null, webSearch: false, endpoint: null };
      return true;
    };

    if (this.settings.provider === "chatgpt") {
      const tokens = this.chatGptTokens();
      const model = this.settings.chatgptModel;
      if (unconfigured([!tokens && "ChatGPT sign-in", !model && "Model"])) return;
      const session = new ChatGptSession(tokens!, (t) => this.storeChatGptTokens(t), fetchWithoutCors);
      const client = new ChatGptClient({ model, session, fetch: fetchWithoutCors });
      this.service = new CommentaryService(store, client);
      this.llmInfo = { model, webSearch: false, endpoint: CHATGPT_ENDPOINT };
      return;
    }

    // The API key is optional: local servers (Ollama, LM Studio…) usually need none.
    if (unconfigured([!this.settings.baseUrl && "Base URL", !this.settings.model && "Model"])) return;
    const apiKey = this.settings.apiKeySecret ? this.app.secretStorage.getSecret(this.settings.apiKeySecret) : null;
    const model = this.settings.model;
    const { client, webSearch, endpoint } = createClient({
      baseUrl: this.settings.baseUrl,
      apiKey: apiKey?.trim() ?? "",
      model,
      webSearch: this.settings.webSearch,
    });
    this.service = new CommentaryService(store, client);
    this.llmInfo = { model, webSearch, endpoint };
  }

  chatGptTokens(): ChatGptTokens | null {
    return parseTokens(this.app.secretStorage.getSecret(CHATGPT_SECRET_ID));
  }

  /** Saves (or with null, forgets) the ChatGPT sign-in on this device. */
  storeChatGptTokens(tokens: ChatGptTokens | null): void {
    this.app.secretStorage.setSecret(CHATGPT_SECRET_ID, tokens ? JSON.stringify(tokens) : "");
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.rebuildService();
  }

  /* ---------- panel ---------- */

  async activateView(): Promise<YorumView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof YorumView ? leaf.view : null;
  }

  /** The panel, showing the note of the given editor context. */
  private async viewFor(ctx: MarkdownView | MarkdownFileInfo): Promise<YorumView | null> {
    const file = ctx.file;
    if (!file) return null;
    const view = await this.activateView();
    await view?.setFile(file);
    return view;
  }

  private selectionCommand(
    checking: boolean,
    editor: Editor,
    ctx: MarkdownView | MarkdownFileInfo,
    request: AskRequest | "lens" | null,
  ): boolean {
    if (!editor.somethingSelected()) return false;
    if (!checking) void this.askAboutSelection(editor, ctx, request);
    return true;
  }

  /**
   * Anchor the selection (block index + quote), then either open the composer (null), pick a
   * lens ("lens"), or send a quick action straight away.
   */
  private async askAboutSelection(
    editor: Editor,
    ctx: MarkdownView | MarkdownFileInfo,
    request: AskRequest | "lens" | null,
  ): Promise<void> {
    if (ctx instanceof MarkdownView) await ctx.save(); // anchors are computed against the saved note
    const quote = editor.getSelection().trim().slice(0, 4000);
    const blockIndex = blockIndexAt(editor.getValue(), editor.posToOffset(editor.getCursor("from")));
    const anchor: Anchor | null = quote && blockIndex !== null ? { blockIndex, quote } : null;
    const view = await this.viewFor(ctx);
    if (!view) return;
    if (request === null) view.openComposer(anchor);
    else if (request === "lens") new LensModal(this.app, (lens) => void view.send(anchor, { lens })).open();
    else void view.send(anchor, request);
  }

  private async focusThread(threadId: string): Promise<void> {
    const view = await this.activateView();
    view?.focusThread(threadId, false);
  }

  openSearch(): void {
    new SearchModal(
      this.app,
      (query) => this.service.search(query),
      (path, threadId) => void this.openSearchHit(path, threadId),
    ).open();
  }

  private async openSearchHit(path: string, threadId: string | null): Promise<void> {
    await this.app.workspace.openLinkText(path, "", false);
    const file = this.app.vault.getFileByPath(path);
    const view = await this.activateView();
    if (file && view) {
      await view.setFile(file);
      if (threadId) view.focusThread(threadId, true);
    }
  }

  async inspect(
    notePath: string,
    input: (AskInput & { threadId?: undefined }) | (ReplyInput & { threadId: string }),
  ): Promise<void> {
    try {
      const preview = await this.service.preview(
        notePath,
        input.threadId !== undefined ? input : { ...input, question: input.question || "(your question)" },
      );
      new InspectorModal(this.app, {
        ...this.llmInfo,
        fast: preview.fast,
        noteTitle: (notePath.split("/").pop() ?? notePath).replace(/\.md$/i, ""),
        related: preview.related,
        messages: preview.messages,
      }).open();
    } catch (err) {
      new Notice(`Yorum: ${(err as Error).message}`);
    }
  }

  /* ---------- editor integration ---------- */

  private editorsFor(notePath: string): MarkdownView[] {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === notePath);
  }

  /** Highlight every commented passage in open editors of this note. */
  syncHighlights(note: NoteView): void {
    for (const view of this.editorsFor(note.path)) {
      const text = view.editor.getValue();
      const ranges = note.sidecar.threads.flatMap((t) => {
        const found = t.anchor ? findQuote(text, t.anchor.quote) : null;
        return found ? [{ from: found[0], to: found[1], threadId: t.id }] : [];
      });
      // Obsidian exposes the CodeMirror 6 view of an editor as `editor.cm`.
      const cm = (view.editor as Editor & { cm?: EditorView }).cm;
      cm?.dispatch({ effects: setAnchors.of(ranges) });
    }
  }

  /** Select and scroll to a quoted passage in the note's editor. */
  revealPassage(notePath: string, quote: string): void {
    const view = this.editorsFor(notePath)[0];
    if (!view) return;
    const found = findQuote(view.editor.getValue(), quote);
    if (!found) {
      new Notice("Yorum: that passage is no longer in the note");
      return;
    }
    const from = view.editor.offsetToPos(found[0]);
    const to = view.editor.offsetToPos(found[1]);
    view.editor.setSelection(from, to);
    view.editor.scrollIntoView({ from, to }, true);
  }

  /**
   * The user asked to put an AI answer into their note: insert the callout after the paragraph
   * that holds the passage (or at the cursor for note-level threads).
   */
  insertBelow(notePath: string, quote: string | null, markdown: string): void {
    const view = this.editorsFor(notePath)[0];
    if (!view) {
      new Notice("Yorum: open the note in an editor first");
      return;
    }
    const editor = view.editor;
    const text = editor.getValue();
    const found = quote ? findQuote(text, quote) : null;
    let at = editor.posToOffset(editor.getCursor());
    if (found) {
      const paragraphEnd = text.indexOf("\n\n", found[1]);
      at = paragraphEnd === -1 ? text.length : paragraphEnd;
    }
    const pos = editor.offsetToPos(at);
    editor.replaceRange(`\n\n${markdown.trimEnd()}\n`, pos);
    new Notice("Inserted into your note");
  }
}

class YorumSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: YorumPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", {
      text: "Answers come from your ChatGPT account or any OpenAI-compatible endpoint. AI comments are stored in the hidden .yorum/ folder at the vault root (one JSON file per note, mirroring its path); your notes are never changed unless you insert an answer yourself.",
    });
    new Setting(containerEl)
      .setName("Provider")
      .setDesc("ChatGPT account: answers count against your ChatGPT plan, no API key needed.")
      .addDropdown((d) =>
        d
          .addOption("openai-compatible", "OpenAI-compatible API")
          .addOption("chatgpt", "ChatGPT account")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value as YorumSettings["provider"];
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    const text = (name: string, desc: string, key: "baseUrl" | "model" | "chatgptModel", placeholder: string) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t
            .setPlaceholder(placeholder)
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
              this.plugin.settings[key] = value.trim();
              await this.plugin.saveSettings();
            }),
        );

    if (this.plugin.settings.provider === "chatgpt") {
      this.chatGptAccount(containerEl);
      text("Model", "A model your plan offers in Codex, e.g. gpt-5.6-terra.", "chatgptModel", "gpt-5.6-terra");
    } else {
      text("Base URL", "e.g. https://api.openai.com/v1, http://localhost:11434/v1, or the full …/chat/completions URL", "baseUrl", "https://api.openai.com/v1");
      new Setting(containerEl)
        .setName("API key")
        .setDesc(
          "Optional: leave empty for local servers that need no key. Kept in Obsidian's Keychain (Settings → Keychain) on this device — not in the vault, so obsidian-git never commits it. Pick an existing secret or create one.",
        )
        .addComponent((el) =>
          new SecretComponent(this.app, el).setValue(this.plugin.settings.apiKeySecret).onChange(async (id) => {
            this.plugin.settings.apiKeySecret = id ?? "";
            await this.plugin.saveSettings();
          }),
        );
      text("Model", "Gemini models (e.g. google/gemini-…) get web search with sources.", "model", "gpt-4o-mini");
      new Setting(containerEl)
        .setName("Web search")
        .setDesc("For Gemini models: let the model search the web when needed and cite sources.")
        .addToggle((t) =>
          t.setValue(this.plugin.settings.webSearch).onChange(async (value) => {
            this.plugin.settings.webSearch = value;
            await this.plugin.saveSettings();
          }),
        );
    }
    new Setting(containerEl)
      .setName("Delete AI comments with their note")
      .setDesc(
        "When you delete a note (or folder), also delete its AI comments in .yorum/. Off: they stay, and come back if a note with the same path is created again. Note: a rename made outside Obsidian while it runs looks like a delete to Obsidian.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.deleteAiDataWithNote).onChange(async (value) => {
          this.plugin.settings.deleteAiDataWithNote = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  /** Sign-in state and buttons. The sign-in is kept in the Keychain on this device only. */
  private chatGptAccount(containerEl: HTMLElement): void {
    const tokens = this.plugin.chatGptTokens();
    const setting = new Setting(containerEl).setName("ChatGPT account");
    const signIn = (mode: "browser" | "code") =>
      new ChatGptSignInModal(this.app, mode, (t) => {
        this.plugin.storeChatGptTokens(t);
        this.plugin.rebuildService();
        this.display();
      }).open();
    if (tokens) {
      setting
        .setDesc(`Signed in${tokens.email ? ` as ${tokens.email}` : ""} on this device.`)
        .addButton((b) =>
          b.setButtonText("Sign out").onClick(() => {
            this.plugin.storeChatGptTokens(null);
            this.plugin.rebuildService();
            this.display();
          }),
        );
      return;
    }
    setting.setDesc(
      Platform.isDesktopApp
        ? "Not signed in. Sign in opens your browser; if that doesn't work, use a one-time code."
        : "Not signed in. You'll enter a one-time code on OpenAI's sign-in page.",
    );
    if (Platform.isDesktopApp) setting.addButton((b) => b.setButtonText("Sign in").setCta().onClick(() => signIn("browser")));
    setting.addButton((b) => {
      b.setButtonText(Platform.isDesktopApp ? "Use a code" : "Sign in").onClick(() => signIn("code"));
      if (!Platform.isDesktopApp) b.setCta();
    });
  }
}

/** `a/b/c.json` → `a/b` */
function parentOf(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}
