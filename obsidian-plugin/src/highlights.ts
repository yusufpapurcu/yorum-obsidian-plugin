import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

/**
 * Passages that have AI comments, highlighted in the Obsidian editor (Live Preview and source
 * mode). Clicking a highlight focuses its thread in the yorum panel.
 */

export interface AnchorRange {
  from: number;
  to: number;
  threadId: string;
}

export const setAnchors = StateEffect.define<AnchorRange[]>();

const anchorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setAnchors)) continue;
      const ranges = effect.value
        .filter((r) => r.to > r.from && r.to <= tr.state.doc.length)
        .sort((a, b) => a.from - b.from);
      next = Decoration.set(
        ranges.map((r) =>
          Decoration.mark({ class: "yorum-anchor", attributes: { "data-yorum-thread": r.threadId } }).range(r.from, r.to),
        ),
        true,
      );
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function anchorHighlights(onClick: (threadId: string) => void): Extension {
  return [
    anchorField,
    EditorView.domEventHandlers({
      click(event) {
        const target = (event.target as HTMLElement | null)?.closest?.("[data-yorum-thread]");
        const threadId = target?.getAttribute("data-yorum-thread");
        if (!threadId) return false;
        onClick(threadId);
        return false; // keep normal cursor placement
      },
    }),
  ];
}

/** Whitespace-insensitive search for a quote; [from, to) offsets into `text`, or null. */
export function findQuote(text: string, quote: string): [number, number] | null {
  const map: number[] = [];
  let normalized = "";
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (normalized === "" || normalized.endsWith(" ")) continue;
      normalized += " ";
    } else {
      normalized += text[i];
    }
    map.push(i);
  }
  const needle = quote.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const at = normalized.indexOf(needle);
  return at === -1 ? null : [map[at], map[at + needle.length - 1] + 1];
}
