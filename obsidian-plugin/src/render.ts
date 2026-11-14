import { type App, type Component, MarkdownRenderer, sanitizeHTMLToDom } from "obsidian";
import { escapeCitations } from "../../src/core/callout.js";
import type { Message } from "../../src/core/types.js";

/**
 * AI comments rendered by Obsidian itself, so Mermaid, math, callouts and [[links]] look exactly
 * like the rest of the vault. Step-by-step sketches (```svg) get a step player; Vega-Lite charts
 * show their source with a hint (Obsidian has no built-in chart renderer).
 */
export async function renderComment(
  app: App,
  el: HTMLElement,
  message: Pick<Message, "content" | "sources" | "related">,
  sourcePath: string,
  component: Component,
): Promise<void> {
  el.empty();
  await MarkdownRenderer.render(app, escapeCitations(message.content), el, sourcePath, component);
  // Diagrams get scaled to the container; in the narrow panel that shrinks wide ones until they're
  // unreadable. Keep each at its natural size and let wide ones scroll sideways. Obsidian's own
  // renderer puts the natural width in the `width` attribute (capped by max-width: 100%); classic
  // Mermaid uses width="100%" and records it as max-width. Diagrams render later, hence the observer.
  const naturalSize = () => {
    for (const svg of Array.from(el.querySelectorAll<SVGSVGElement>(".mermaid svg:not([data-yorum-sized])"))) {
      svg.dataset.yorumSized = "true";
      if (svg.getAttribute("width")?.endsWith("%") && svg.style.maxWidth.endsWith("px")) svg.style.width = svg.style.maxWidth;
      svg.style.maxWidth = "none";
    }
  };
  const observer = new MutationObserver(naturalSize);
  observer.observe(el, { childList: true, subtree: true });
  component.register(() => observer.disconnect());
  naturalSize();
  for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>("a.external-link"))) {
    if (/^\[\d+\]$/.test(a.textContent ?? "")) a.addClass("yorum-cite");
  }
  for (const code of Array.from(el.querySelectorAll<HTMLElement>("pre > code.language-svg"))) {
    const pre = code.parentElement!;
    const stage = createDiv({ cls: "yorum-sketch" });
    try {
      renderSketch(stage, code.textContent ?? "");
      pre.replaceWith(stage);
    } catch (err) {
      pre.before(createDiv({ cls: "yorum-viz-error", text: `Couldn't draw this sketch: ${(err as Error).message}` }));
    }
  }
  for (const code of Array.from(el.querySelectorAll<HTMLElement>("pre > code.language-vega-lite"))) {
    code.parentElement!.before(
      createDiv({ cls: "yorum-viz-hint", text: "Chart (Vega-Lite) — open this note in the yorum web app to see it drawn." }),
    );
  }
  if (message.sources?.length) {
    const box = el.createDiv({ cls: "yorum-sources" });
    box.createDiv({ cls: "yorum-sources-label", text: "Sources" });
    const list = box.createEl("ol");
    for (const s of message.sources) {
      const li = list.createEl("li");
      let label = s.title;
      try {
        const url = new URL(s.url);
        const host = url.hostname.replace(/^www\./, "");
        if (!host.endsWith("vertexaisearch.cloud.google.com")) {
          label = `${host === s.title || host.endsWith(`.${s.title}`) ? host : s.title}${url.pathname === "/" ? "" : url.pathname}`;
        }
      } catch {
        // keep the title
      }
      li.createEl("a", { text: label, href: s.url, cls: "external-link" });
    }
  }
  if (message.related?.length) {
    const box = el.createDiv({ cls: "yorum-related", text: "From your vault: " });
    message.related.forEach((notePath, i) => {
      if (i) box.appendText(" · ");
      const name = (notePath.split("/").pop() ?? notePath).replace(/\.md$/i, "");
      box.createEl("a", { text: name, cls: "internal-link", attr: { "data-href": notePath, href: notePath } });
    });
  }
}

/** A sanitized SVG whose `<g data-step="n" data-caption="…">` groups are revealed one at a time. */
function renderSketch(stage: HTMLElement, source: string): void {
  const svg = sanitizeHTMLToDom(source).querySelector("svg");
  if (!svg) throw new Error("no <svg> element");
  for (const bad of Array.from(svg.querySelectorAll("script, style, foreignObject, image, a, use"))) bad.remove();
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.addClass("yorum-sketch-svg");
  stage.append(svg);

  const steps = Array.from(svg.querySelectorAll<SVGGElement>("[data-step]"));
  const numbers = [...new Set(steps.map((s) => Number(s.dataset.step)))].sort((a, b) => a - b);
  if (numbers.length < 2) return;
  const controls = stage.createDiv({ cls: "yorum-steps" });
  const prev = controls.createEl("button", { text: "‹", attr: { "aria-label": "Previous step" } });
  const counter = controls.createSpan({ cls: "yorum-step-count" });
  const next = controls.createEl("button", { text: "›", attr: { "aria-label": "Next step" } });
  const all = controls.createEl("button", { text: "All" });
  const caption = stage.createDiv({ cls: "yorum-step-caption" });
  let at = 0;
  const show = (index: number) => {
    at = Math.max(0, Math.min(index, numbers.length - 1));
    const limit = numbers[at];
    for (const s of steps) {
      const n = Number(s.dataset.step);
      s.style.display = n <= limit ? "" : "none";
      s.toggleClass("current", n === limit);
    }
    counter.setText(`${at + 1}/${numbers.length}`);
    caption.setText(steps.find((s) => Number(s.dataset.step) === limit)?.dataset.caption ?? "");
    prev.disabled = at === 0;
    next.disabled = at === numbers.length - 1;
  };
  prev.onclick = () => show(at - 1);
  next.onclick = () => show(at + 1);
  all.onclick = () => show(numbers.length - 1);
  show(0);
}
