import { type App, Modal, SuggestModal } from "obsidian";
import { AUTO_LENS, LENS_PRESETS } from "../../src/core/actions.js";
import type { RelatedNote } from "../../src/core/connections.js";
import type { SearchHit, Snippet } from "../../src/core/search.js";
import type { ChatMessage } from "../../src/core/types.js";

/** Pick a framework to explain the passage through: Surprise me, a preset, or anything typed. */
export class LensModal extends SuggestModal<string> {
  constructor(
    app: App,
    private readonly onPick: (lens: string) => void,
  ) {
    super(app);
    this.setPlaceholder("Explain it through… (type any framework, e.g. Kübler-Ross stages of grief)");
  }

  getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    const presets = [AUTO_LENS, ...LENS_PRESETS].filter((l) => !q || l.toLowerCase().includes(q));
    // Matching presets first (typing "holling" should pick the full framework name); the typed
    // text itself is offered last, for frameworks that aren't presets.
    return q && !presets.some((l) => l.toLowerCase() === q) ? [...presets, query.trim()] : presets;
  }

  renderSuggestion(lens: string, el: HTMLElement): void {
    if (lens === AUTO_LENS) el.setText("✨ Surprise me — a fitting framework from another field");
    else if ([...LENS_PRESETS].includes(lens)) el.setText(lens);
    else el.setText(`Use “${lens}”`);
  }

  onChooseSuggestion(lens: string): void {
    this.onPick(lens);
  }
}

type SearchItem =
  | { kind: "note"; hit: SearchHit; snippet: Snippet | null }
  | { kind: "comment"; hit: SearchHit; snippet: Snippet; threadId: string; role: "user" | "assistant" };

function appendHighlighted(el: HTMLElement, text: string, ranges: [number, number][]): void {
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    el.appendText(text.slice(at, start));
    el.createEl("mark", { text: text.slice(start, end) });
    at = end;
  }
  el.appendText(text.slice(at));
}

/** Search across note titles, note text and AI comments; a comment result opens its thread. */
export class SearchModal extends SuggestModal<SearchItem> {
  constructor(
    app: App,
    private readonly search: (query: string) => Promise<SearchHit[]>,
    private readonly openResult: (path: string, threadId: string | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Search notes & AI comments…");
  }

  async getSuggestions(query: string): Promise<SearchItem[]> {
    if (query.trim().length < 2) return [];
    const hits = await this.search(query);
    return hits.flatMap((hit): SearchItem[] => [
      { kind: "note", hit, snippet: hit.snippets[0] ?? null },
      ...hit.comments.map((c) => ({ kind: "comment" as const, hit, snippet: c.snippet, threadId: c.threadId, role: c.role })),
    ]);
  }

  renderSuggestion(item: SearchItem, el: HTMLElement): void {
    el.addClass("yorum-search-item");
    if (item.kind === "note") {
      appendHighlighted(el.createDiv({ cls: "yorum-search-title" }), item.hit.title, item.hit.titleHighlights);
      if (item.snippet) appendHighlighted(el.createDiv({ cls: "yorum-search-snippet" }), item.snippet.text, item.snippet.highlights);
    } else {
      const line = el.createDiv({ cls: `yorum-search-snippet comment ${item.role}` });
      line.appendText(item.role === "assistant" ? "💬 AI · " : "💬 You · ");
      appendHighlighted(line, item.snippet.text, item.snippet.highlights);
    }
  }

  onChooseSuggestion(item: SearchItem): void {
    this.openResult(item.hit.path, item.kind === "comment" ? item.threadId : null);
  }
}

export interface InspectorData {
  endpoint: string | null;
  model: string | null;
  webSearch: boolean;
  fast: boolean;
  noteTitle: string;
  related: RelatedNote[];
  messages: ChatMessage[];
}

/** What the AI sees: destination, every vault note included, size, and the full request. */
export class InspectorModal extends Modal {
  constructor(
    app: App,
    private readonly data: InspectorData,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, data } = this;
    this.setTitle("What the AI sees");
    contentEl.addClass("yorum-inspector");
    const characters = data.messages.reduce((n, m) => n + m.content.length, 0);
    const summary = contentEl.createDiv({ cls: "yorum-inspector-summary" });
    summary.appendText("Sent to ");
    summary.createEl("strong", { text: data.endpoint ?? "nowhere (configure the model in settings)" });
    summary.appendText(
      ` · ${data.model ?? "no model"}${data.webSearch ? " · may search the web" : ""}${data.fast ? " · fast mode" : ""}`,
    );
    summary.createEl("br");
    summary.appendText(
      `About ${Math.round(characters / 4).toLocaleString()} tokens (${characters.toLocaleString()} characters). Nothing else from your vault leaves this device.`,
    );
    contentEl.createEl("h4", { text: `From your vault (${data.related.length + 1} notes)` });
    const list = contentEl.createEl("ul");
    list.createEl("li", { text: `${data.noteTitle} — this note, in full` });
    for (const n of data.related) {
      list.createEl("li", { text: `${n.title} — ${n.relation}, excerpt of ${n.excerpt.length.toLocaleString()} characters` });
    }
    contentEl.createEl("h4", { text: "The request" });
    for (const m of data.messages) {
      const details = contentEl.createEl("details", { cls: `yorum-inspector-message ${m.role}` });
      details.open = m.role !== "system";
      details.createEl("summary", { text: `${m.role} · ${m.content.length.toLocaleString()} characters` });
      details.createEl("pre", { text: m.content });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** A diagram from a comment, at full size (the panel is too narrow for wide diagrams). */
export class DiagramModal extends Modal {
  constructor(
    app: App,
    private readonly diagram: Element,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("yorum-diagram-modal");
    const copy = this.diagram.cloneNode(true) as HTMLElement;
    // In the panel diagrams keep their natural size; here they fit the modal (CSS).
    copy.querySelector("svg")?.removeClass("yorum-natural-size");
    this.contentEl.append(copy);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
