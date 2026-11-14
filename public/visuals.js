import DOMPurify from "/vendor/purify.es.mjs";
import { createMarked } from "./markdown.js";

/**
 * Renders AI comments: Obsidian-flavoured Markdown, citation links + source list (web search), and
 * visuals the model writes as fenced blocks: ```mermaid, ```svg (step-by-step sketch), ```vega-lite.
 * Heavy renderers (Mermaid, Vega, KaTeX) load on first use.
 */

const commentMarked = createMarked({ allowHtml: false, visualKinds: { mermaid: true, svg: true, "vega-lite": true } });

/**
 * `streaming`: the text is still arriving — fences may be unclosed, so visuals show a "drawing…"
 * placeholder and nothing heavy is hydrated until the final render.
 */
export function renderAssistantMessage(el, message, { streaming = false } = {}) {
  el.innerHTML = commentMarked.parse(message.content);
  for (const a of el.querySelectorAll("a[href]")) {
    if (a.getAttribute("href").startsWith("#")) continue; // [[links]] to vault notes stay in the app
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    if (/^\[\d+\]$/.test(a.textContent)) a.classList.add("cite");
  }
  if (streaming) {
    for (const viz of el.querySelectorAll(".viz")) viz.classList.add("drawing");
    return;
  }
  if (message.sources?.length) el.append(sourcesList(message.sources));
  if (message.related?.length) el.append(relatedList(message.related));
  hydrateRich(el);
}

/** Which of the user's notes the AI was given for this answer (vault connections). */
function relatedList(paths) {
  const wrap = document.createElement("div");
  wrap.className = "related";
  wrap.append("From your vault: ");
  paths.forEach((path, i) => {
    if (i) wrap.append(" · ");
    const a = document.createElement("a");
    a.className = "internal-link";
    a.href = `#${encodeURIComponent(path)}`;
    a.textContent = path.split("/").pop().replace(/\.md$/i, "");
    wrap.append(a);
  });
  return wrap;
}

/** Draw the visuals and math inside freshly rendered HTML (comments or note blocks). */
export function hydrateRich(root) {
  for (const viz of root.querySelectorAll(".viz:not([data-hydrated])")) hydrate(viz);
  const math = root.querySelectorAll(".math:not(.ready)");
  if (math.length) renderMath(math);
}

let katexReady = null;

async function renderMath(nodes) {
  katexReady ??= (() => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/vendor/katex/katex.min.css";
    document.head.append(css);
    return loadScript("/vendor/katex/katex.min.js");
  })();
  await katexReady;
  for (const node of nodes) {
    window.katex.render(node.dataset.tex, node, {
      displayMode: node.classList.contains("math-display"),
      throwOnError: false,
    });
    node.classList.add("ready");
  }
}

function sourcesList(sources) {
  const wrap = document.createElement("div");
  wrap.className = "sources";
  const label = document.createElement("div");
  label.className = "sources-label";
  label.textContent = "Sources";
  const list = document.createElement("ol");
  for (const source of sources) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = source.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = source.title;
    li.append(a);
    try {
      const url = new URL(source.url);
      const host = url.hostname.replace(/^www\./, "");
      // Unresolved Google redirect links say nothing useful; keep just the title for those.
      if (!host.endsWith("vertexaisearch.cloud.google.com")) {
        const path = url.pathname === "/" ? "" : url.pathname;
        // Grounding titles are often just the domain; then the URL itself is the label.
        const titleIsDomain = host === source.title || host.endsWith(`.${source.title}`);
        a.replaceChildren(titleIsDomain ? host : source.title);
        const where = document.createElement("span");
        where.className = "source-url";
        where.textContent = titleIsDomain ? path : `${host}${path}`;
        if (where.textContent) li.append(where);
      }
    } catch {
      // Not a parseable URL: the title link is enough.
    }
    list.append(li);
  }
  wrap.append(label, list);
  return wrap;
}

async function hydrate(viz) {
  viz.dataset.hydrated = "true";
  const source = viz.querySelector(".viz-src").textContent;
  const kind = viz.dataset.kind;
  const stage = document.createElement("div");
  stage.className = "viz-stage";
  viz.prepend(stage);
  try {
    if (kind === "mermaid") await renderMermaid(stage, source);
    else if (kind === "svg") renderSketch(stage, source);
    else await renderVegaLite(stage, source);
    viz.classList.add("ready");
  } catch (err) {
    stage.remove();
    const note = document.createElement("div");
    note.className = "viz-error";
    note.textContent = `Couldn't draw this ${kind} visual: ${err.message ?? err}`;
    viz.prepend(note);
    viz.classList.add("failed");
  }
}

/* ---------- mermaid ---------- */

let mermaidReady = null;
const mermaidCache = new Map();
let mermaidId = 0;

async function renderMermaid(stage, source) {
  // Lazy: Mermaid is ~3 MB and most comments have no diagram, so it loads on the first one.
  mermaidReady ??= import("/vendor/mermaid/mermaid.esm.min.mjs").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", fontFamily: "inherit" });
    return mermaid;
  });
  const mermaid = await mermaidReady;
  let svg = mermaidCache.get(source);
  if (!svg) {
    const id = `mermaid-${++mermaidId}`;
    try {
      ({ svg } = await mermaid.render(id, source));
    } finally {
      // A failed render leaves its scratch element in <body>.
      document.getElementById(`d${id}`)?.remove();
    }
    mermaidCache.set(source, svg);
  }
  stage.innerHTML = svg;
}

/* ---------- step-by-step SVG sketch ---------- */

function renderSketch(stage, source) {
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["style", "foreignObject", "image", "a", "use"],
  });
  const holder = document.createElement("div");
  holder.innerHTML = clean;
  const svg = holder.querySelector("svg");
  if (!svg) throw new Error("no <svg> element");
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.classList.add("sketch");
  stage.append(svg);

  const steps = [...svg.querySelectorAll("[data-step]")].sort(
    (a, b) => Number(a.dataset.step) - Number(b.dataset.step),
  );
  const count = new Set(steps.map((s) => s.dataset.step)).size;
  if (count < 2) return;
  const stepNumbers = [...new Set(steps.map((s) => Number(s.dataset.step)))];

  const controls = document.createElement("div");
  controls.className = "steps";
  const prev = button("‹", "Previous step");
  const next = button("›", "Next step");
  const all = button("All", "Show every step");
  const counter = document.createElement("span");
  counter.className = "step-count";
  const caption = document.createElement("div");
  caption.className = "step-caption";
  controls.append(prev, counter, next, all);
  stage.append(controls, caption);

  let at = 0;
  const show = (index) => {
    at = Math.max(0, Math.min(index, stepNumbers.length - 1));
    const limit = stepNumbers[at];
    for (const s of steps) {
      const n = Number(s.dataset.step);
      s.style.display = n <= limit ? "" : "none";
      s.classList.toggle("current", n === limit);
    }
    counter.textContent = `${at + 1}/${stepNumbers.length}`;
    caption.textContent = steps.find((s) => Number(s.dataset.step) === limit)?.dataset.caption ?? "";
    prev.disabled = at === 0;
    next.disabled = at === stepNumbers.length - 1;
  };
  prev.addEventListener("click", (e) => (e.stopPropagation(), show(at - 1)));
  next.addEventListener("click", (e) => (e.stopPropagation(), show(at + 1)));
  all.addEventListener("click", (e) => (e.stopPropagation(), show(stepNumbers.length - 1)));
  show(0);
}

function button(label, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  return b;
}

/* ---------- vega-lite ---------- */

let vegaReady = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(script);
  });
}

async function renderVegaLite(stage, source) {
  const spec = JSON.parse(source);
  vegaReady ??= loadScript("/vendor/vega.min.js")
    .then(() => loadScript("/vendor/vega-lite.min.js"))
    .then(() => loadScript("/vendor/vega-embed.min.js"));
  await vegaReady;
  // Charts must carry their data inline; never fetch URLs named by the model.
  const loader = window.vega.loader();
  loader.load = async (uri) => {
    throw new Error(`external data is disabled (${uri})`);
  };
  await window.vegaEmbed(stage, spec, { actions: false, renderer: "svg", loader });
}
