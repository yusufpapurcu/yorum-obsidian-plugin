import { NOT_IN_OBSIDIAN, createMarked, obsidianUrl, setVaultIndex } from "./markdown.js";
import { toObsidianCallout } from "/core/callout.js";
import { hydrateRich, renderAssistantMessage } from "./visuals.js";

// Notes are the user's own files and may contain HTML (as in Obsidian); Mermaid renders like in Obsidian.
const noteMarked = createMarked({ allowHtml: true, visualKinds: { mermaid: true } });

const MAX_QUOTE = 4000;
const $ = (selector, root = document) => root.querySelector(selector);

const state = { current: null, focusThreadId: null, actions: [], lenses: [], status: null };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const noteUrl = (suffix = "") => `/api/note${suffix}?path=${encodeURIComponent(state.current.path)}`;

/**
 * POST that streams the answer. `live.onContext` gets the vault notes being read, `live.onDelta`
 * the text as the model writes it; resolves with the saved thread from the final `done` event.
 */
async function apiStream(url, body, live) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
      if (event === "delta") live.onDelta(data.text);
      else if (event === "context") live.onContext(data.notes);
      else if (event === "done") return data;
      else if (event === "error") throw new Error(data.error);
    }
  }
  throw new Error("The answer stream ended early");
}

/** A "thinking…" line that names what is being read, then turns into the answer as it streams. */
function liveAnswer() {
  const el = statusEl("thinking…", "pending");
  let text = "";
  let frame = 0;
  const onContext = (notes) => {
    if (text || !notes.length) return;
    const names = notes.map((n) => n.path.split("/").pop().replace(/\.md$/i, ""));
    el.textContent = `thinking with ${names.join(", ")}…`;
  };
  const onDelta = (delta) => {
    text += delta;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      el.className = "msg assistant streaming";
      renderAssistantMessage(el, { content: text }, { streaming: true });
    });
  };
  return { el, onContext, onDelta };
}

/* ---------- sidebar ---------- */

async function loadSidebar() {
  const [status, listing] = await Promise.all([api("GET", "/api/status"), api("GET", "/api/notes")]);
  state.status = status;
  const statusEl = $("#status");
  statusEl.textContent = status.llmConfigured
    ? `model: ${status.model}${status.webSearch ? " · web search on" : ""}`
    : "LLM not configured — see .env.example";
  statusEl.classList.toggle("warn", !status.llmConfigured);
  renderListing(listing);
  return listing.notes;
}

function renderListing({ notes, files, commentCounts = {} }) {
  setVaultIndex({ obsidian: state.status.obsidian, notes, files });
  $("#notes").replaceChildren(
    ...notes.map((path) => {
      const a = document.createElement("a");
      a.href = `#${encodeURIComponent(path)}`;
      a.dataset.path = path;
      const name = document.createElement("span");
      name.textContent = path.replace(/\.md$/i, "");
      a.append(name);
      if (commentCounts[path]) {
        const count = document.createElement("span");
        count.className = "count";
        count.title = `${commentCounts[path]} comment thread${commentCounts[path] === 1 ? "" : "s"}`;
        count.textContent = String(commentCounts[path]);
        a.append(count);
      }
      return a;
    }),
  );
  markActive();
}

/* ---------- search across notes and AI comments ---------- */

const searchInput = $("#search");
const searchResults = $("#search-results");
let searchTimer = 0;
let searchSeq = 0;

/** `text` with the snippet's highlight ranges wrapped in <mark>. */
function highlighted(text, ranges) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    frag.append(text.slice(at, start));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, end);
    frag.append(mark);
    at = end;
  }
  frag.append(text.slice(at));
  return frag;
}

async function runSearch() {
  const query = searchInput.value.trim();
  const searching = query.length >= 2;
  searchResults.hidden = !searching;
  $("#notes").hidden = searching;
  if (!searching) return;
  const seq = ++searchSeq;
  const { results } = await api("GET", `/api/search?q=${encodeURIComponent(query)}`);
  if (seq !== searchSeq) return; // a newer query is in flight
  if (!results.length) {
    searchResults.replaceChildren(Object.assign(document.createElement("p"), { className: "empty hint", textContent: "No matches in notes or comments." }));
    return;
  }
  searchResults.replaceChildren(
    ...results.map((hit) => {
      const item = document.createElement("div");
      item.className = "result";
      const title = document.createElement("a");
      title.className = "result-title";
      title.href = `#${encodeURIComponent(hit.path)}`;
      title.append(highlighted(hit.title, hit.titleHighlights));
      item.append(title);
      for (const s of hit.snippets) {
        const line = document.createElement("a");
        line.className = "result-snippet";
        line.href = `#${encodeURIComponent(hit.path)}`;
        line.append(highlighted(s.text, s.highlights));
        item.append(line);
      }
      for (const c of hit.comments) {
        const line = document.createElement("a");
        line.className = `result-snippet comment ${c.role}`;
        line.href = `#${encodeURIComponent(hit.path)}`;
        line.title = c.role === "assistant" ? "AI comment" : "Your question";
        line.append(highlighted(c.snippet.text, c.snippet.highlights));
        line.addEventListener("click", (event) => {
          event.preventDefault();
          openAtThread(hit.path, c.threadId);
        });
        item.append(line);
      }
      return item;
    }),
  );
}

/** Open a note (if needed) and bring one comment thread into focus. */
async function openAtThread(path, threadId) {
  if (state.current?.path !== path) {
    state.focusOnOpen = threadId;
    location.hash = encodeURIComponent(path);
    return;
  }
  focusThread(threadId, "card");
  focusThread(threadId, "passage");
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch().catch((err) => console.error(err)), 150);
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    searchInput.value = "";
    runSearch();
    searchInput.blur();
  }
});
document.addEventListener("keydown", (event) => {
  const typing = event.target.closest?.("input, textarea, [contenteditable]");
  if ((event.key === "/" && !typing) || (event.key === "k" && (event.metaKey || event.ctrlKey))) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

/* ---------- live sync with Obsidian ---------- */

const syncTimers = new Map();

/** A file in the vault changed on disk (typically: the user is writing in Obsidian). */
function onVaultChange(change) {
  const key = `${change.kind}:${change.path}`;
  clearTimeout(syncTimers.get(key));
  syncTimers.set(
    key,
    setTimeout(async () => {
      syncTimers.delete(key);
      if (change.structural || change.kind === "files" || change.kind === "sidecar") {
        renderListing(await api("GET", "/api/notes"));
      }
      if (searchInput.value.trim().length >= 2) runSearch();
      if (change.path !== state.current?.path || change.kind === "files") return;
      let fresh;
      try {
        fresh = await api("GET", `/api/note?path=${encodeURIComponent(change.path)}`);
      } catch {
        $(".note-path").textContent = `${change.path} — deleted or moved`;
        return;
      }
      if (change.path !== state.current?.path) return;
      if (change.kind === "sidecar") {
        if (JSON.stringify(fresh.sidecar) === JSON.stringify(state.current.sidecar)) return;
        state.current.sidecar = fresh.sidecar;
      } else {
        if (fresh.markdown === state.current.markdown) return;
        Object.assign(state.current, { markdown: fresh.markdown, blocks: fresh.blocks, properties: fresh.properties });
        $("#main .properties")?.remove();
        if (fresh.properties && Object.keys(fresh.properties).length) $("#main .doc").before(propertiesEl(fresh.properties));
        flashSynced();
      }
      renderThreads();
    }, 80),
  );
}

function flashSynced() {
  const badge = $(".sync-badge") ?? document.createElement("span");
  badge.className = "sync-badge";
  badge.textContent = "↻ synced from disk";
  $(".note-toolbar .note-path")?.after(badge);
  clearTimeout(flashSynced.timer);
  flashSynced.timer = setTimeout(() => badge.remove(), 2500);
}

function markActive() {
  for (const a of document.querySelectorAll("#notes a")) {
    a.classList.toggle("active", a.dataset.path === state.current?.path);
  }
}

/* ---------- note ---------- */

async function openNote(path) {
  state.current = await api("GET", `/api/note?path=${encodeURIComponent(path)}`);
  state.focusThreadId = null;
  renderNote();
  markActive();
  if (state.focusOnOpen) {
    const threadId = state.focusOnOpen;
    state.focusOnOpen = null;
    focusThread(threadId, "card");
    focusThread(threadId, "passage");
  }
}

function renderNote() {
  const note = state.current;
  const main = $("#main");
  main.replaceChildren($("#note-template").content.cloneNode(true));
  const titleEl = $(".note-title", main);
  titleEl.textContent = note.title;
  // The note's own top-level heading already shows the title.
  titleEl.hidden = note.blocks[0]?.type === "heading" && /^#\s/.test(note.blocks[0].raw);
  if (note.properties && Object.keys(note.properties).length) $(".doc", main).before(propertiesEl(note.properties));
  $(".note-path", main).textContent = note.path.replace(/\.md$/i, "");
  const open = $(".open-obsidian", main);
  const url = obsidianUrl(note.path);
  if (url) open.href = url;
  else {
    open.classList.add("disabled");
    open.title = NOT_IN_OBSIDIAN;
  }

  const form = $(".intent", main);
  const textarea = $("textarea", form);
  const intentState = $(".intent-state", form);
  textarea.value = note.sidecar.intent;
  const starters = $(".intent-starters", form);
  textarea.addEventListener("input", () => {
    intentState.textContent = textarea.value === state.current.sidecar.intent ? "" : "unsaved";
    starters.hidden = textarea.value.trim() !== "";
  });
  renderIntentStarters(starters, (intent) => {
    textarea.value = intent;
    starters.hidden = true;
    form.requestSubmit();
  });
  starters.hidden = note.sidecar.intent.trim() !== "";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    intentState.textContent = "saving…";
    try {
      const sidecar = await api("PUT", noteUrl("/intent"), { intent: textarea.value });
      state.current.sidecar.intent = sidecar.intent;
      intentState.textContent = "saved";
    } catch (err) {
      intentState.textContent = err.message;
    }
  });

  $("#ask-note").disabled = false;
  $("#threads").replaceChildren();
  renderThreads();
}

const GENERIC_INTENTS = [
  "Quiz me on this until I really understand it.",
  "Challenge my thinking; tell me where I'm wrong.",
  "Explain things like I'm new to this topic.",
  "Connect this to my other notes and to ideas from other fields.",
];

/**
 * One-click intents: a few generic starters plus "Suggest for this note", which asks the AI for
 * three intents tailored to the note (in the note's language).
 */
function renderIntentStarters(container, apply) {
  const suggest = chip("✨ Suggest for this note", async (b) => {
    b.disabled = true;
    b.textContent = "Reading your note…";
    try {
      const { suggestions } = await api("POST", noteUrl("/intent-suggestions"));
      container.replaceChildren(...suggestions.map((s) => chip(s, () => apply(s), "chip suggestion")));
    } catch (err) {
      b.disabled = false;
      b.textContent = "✨ Suggest for this note";
      b.title = err.message;
    }
  }, "chip suggest");
  container.replaceChildren(suggest, ...GENERIC_INTENTS.map((s) => chip(s, () => apply(s))));
}

/**
 * Re-render the note blocks (with highlights) and the comment panel. Threads are listed in
 * reading order: note-level and orphaned threads first, then by position in the note.
 */
function renderThreads() {
  const doc = $("#main .doc");
  const blockEls = state.current.blocks.map((block) => {
    const blockEl = document.createElement("div");
    blockEl.className = "block";
    blockEl.dataset.index = String(block.index);
    blockEl.innerHTML = noteMarked.parse(block.raw);

    const ask = document.createElement("button");
    ask.type = "button";
    ask.className = "block-ask";
    ask.title = "Ask about this paragraph";
    ask.textContent = "+";
    ask.addEventListener("click", () => {
      openComposer({ blockIndex: block.index, quote: blockText(blockEl).trim().slice(0, MAX_QUOTE) });
    });
    blockEl.append(ask);
    return blockEl;
  });
  doc.replaceChildren(...blockEls);
  hydrateRich(doc);
  hydrateEmbeds(doc);

  const placed = state.current.sidecar.threads.map((thread) => {
    const where = locate(thread, blockEls);
    if (where) highlight(where.blockEl, where.range, thread.id);
    return {
      thread,
      orphaned: where === null && thread.anchor !== null,
      sortKey: where ? [Number(where.blockEl.dataset.index), where.range.start] : [-1, 0],
    };
  });
  placed.sort((a, b) => a.sortKey[0] - b.sortKey[0] || a.sortKey[1] - b.sortKey[1]);

  const list = $("#threads");
  const composer = $(".card.composer", list);
  // Keep half-typed replies across re-renders (live sync can re-render at any moment).
  const drafts = [...list.querySelectorAll(".card[data-thread]")]
    .map((card) => [card.dataset.thread, card.querySelector("form textarea")?.value ?? ""])
    .filter(([, text]) => text);
  list.replaceChildren(...placed.map(({ thread, orphaned }) => threadCard(thread, orphaned)));
  if (composer) list.prepend(composer);
  for (const [id, text] of drafts) {
    const textarea = list.querySelector(`.card[data-thread="${id}"] form textarea`);
    if (textarea) textarea.value = text;
  }
  if (!placed.length && !composer) {
    const hint = document.createElement("p");
    hint.className = "empty hint";
    hint.textContent = "No comments yet. Select text and press “Ask about this”, or hover a paragraph and press +.";
    list.append(hint);
  }
  applyFocus();
}

/** Obsidian-style properties box for YAML frontmatter. */
function propertiesEl(properties) {
  const dl = document.createElement("dl");
  dl.className = "properties";
  for (const [key, values] of Object.entries(properties)) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    const isTags = key === "tags" || key === "tag";
    for (const value of values) {
      const chip = document.createElement("span");
      chip.className = isTags ? "tag" : "property-value";
      chip.textContent = isTags ? `#${value.replace(/^#/, "")}` : value;
      dd.append(chip);
    }
    dl.append(dt, dd);
  }
  return dl;
}

/** Transclude `![[Other note]]` one level deep, like Obsidian's embed preview. */
async function hydrateEmbeds(root) {
  for (const embed of root.querySelectorAll(".embed[data-embed-path]:not([data-loaded])")) {
    embed.dataset.loaded = "true";
    try {
      const note = await api("GET", `/api/note?path=${encodeURIComponent(embed.dataset.embedPath)}`);
      const body = document.createElement("div");
      body.className = "embed-body";
      body.innerHTML = note.blocks.map((b) => noteMarked.parse(b.raw)).join("");
      for (const nested of body.querySelectorAll(".embed")) nested.dataset.loaded = "true";
      embed.append(body);
      hydrateRich(body);
    } catch (err) {
      embed.title = err.message;
    }
  }
}

/** Find where a thread's quote lives now: its original block first, then anywhere (the note may have changed). */
function locate(thread, blockEls) {
  if (!thread.anchor) return null;
  const { blockIndex, quote } = thread.anchor;
  const order = [blockEls[blockIndex], ...blockEls.filter((_, i) => i !== blockIndex)].filter(Boolean);
  for (const blockEl of order) {
    const range = findQuote(blockText(blockEl), quote);
    if (range) return { blockEl, range };
  }
  return null;
}

/* ---------- text matching & highlighting ---------- */

function textNodes(blockEl) {
  // Embedded notes belong to another file: never part of this note's anchor text.
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement.closest(".block-ask, .embed-body") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function blockText(blockEl) {
  return textNodes(blockEl)
    .map((n) => n.data)
    .join("");
}

/** Whitespace-insensitive search; returns [start, end) offsets into the original text. */
function findQuote(text, quote) {
  const map = [];
  let normalized = "";
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (normalized.endsWith(" ") || normalized === "") continue;
      normalized += " ";
    } else {
      normalized += text[i];
    }
    map.push(i);
  }
  const needle = quote.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const at = normalized.indexOf(needle);
  if (at === -1) return null;
  return { start: map[at], end: map[at + needle.length - 1] + 1 };
}

function highlight(blockEl, { start, end }, threadId) {
  let offset = 0;
  for (const node of textNodes(blockEl)) {
    const nodeStart = offset;
    const nodeEnd = offset + node.data.length;
    offset = nodeEnd;
    if (nodeEnd <= start || nodeStart >= end) continue;
    let target = node;
    const from = Math.max(start - nodeStart, 0);
    const to = Math.min(end - nodeStart, node.data.length);
    if (to < target.data.length) target.splitText(to);
    if (from > 0) target = target.splitText(from);
    if (!target.data.trim()) continue;
    const mark = document.createElement("mark");
    mark.className = "anchor";
    mark.dataset.thread = threadId;
    mark.addEventListener("click", () => focusThread(threadId, "card"));
    target.replaceWith(mark);
    mark.append(target);
  }
}

/** Focus a thread and bring its counterpart into view: the card in the panel or the passage in the note. */
function focusThread(threadId, reveal) {
  state.focusThreadId = threadId;
  applyFocus();
  const target =
    reveal === "card"
      ? document.querySelector(`.card[data-thread="${threadId}"]`)
      : document.querySelector(`mark[data-thread="${threadId}"]`);
  target?.scrollIntoView({ block: reveal === "card" ? "start" : "center", behavior: "smooth" });
}

function applyFocus() {
  for (const el of document.querySelectorAll("[data-thread]")) {
    el.classList.toggle("focus", el.dataset.thread === state.focusThreadId);
  }
}

/* ---------- comment cards ---------- */

function messageEl(message, index, thread) {
  const el = document.createElement("div");
  el.className = `msg ${message.role}`;
  if (message.role !== "assistant") {
    el.textContent = message.content;
    return el;
  }
  renderAssistantMessage(el, message);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "link copy-callout";
  copy.textContent = "Copy to Obsidian";
  copy.title = "Copy as an Obsidian callout to paste into your note";
  copy.addEventListener("click", async (event) => {
    event.stopPropagation();
    const question = thread.messages.slice(0, index).findLast((m) => m.role === "user")?.content ?? "";
    const markdown = toObsidianCallout({
      question,
      answer: message.content,
      quote: thread.anchor?.quote,
      lens: thread.lens && thread.lens !== "auto" ? thread.lens : null,
      sources: message.sources ?? [],
      date: new Date(message.createdAt),
    });
    await navigator.clipboard.writeText(markdown);
    copy.textContent = "Copied ✓ — paste into your note";
    setTimeout(() => (copy.textContent = "Copy to Obsidian"), 2500);
  });
  el.append(copy);
  return el;
}

function statusEl(text, kind) {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.textContent = text;
  return el;
}

function quoteEl(anchor) {
  const el = document.createElement("div");
  el.className = "quote";
  el.textContent = anchor.quote;
  return el;
}

/** A small textarea form; `onSubmit` returns a promise, errors are shown inline. */
function composeForm({ placeholder, submitLabel, onSubmit, onCancel, extra, allowEmpty = () => false }) {
  const form = document.createElement("form");
  const textarea = document.createElement("textarea");
  textarea.rows = 2;
  textarea.placeholder = placeholder;
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const left = document.createElement("span");
  left.append(...[extra].flat().filter(Boolean));
  const right = document.createElement("span");
  if (onCancel) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", onCancel);
    right.append(cancel, " ");
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = submitLabel;
  right.append(submit);
  actions.append(left, right);
  form.append(textarea, actions);

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = textarea.value.trim();
    if (!text && !allowEmpty()) return;
    textarea.disabled = submit.disabled = true;
    try {
      await onSubmit(text);
    } catch (err) {
      form.before(statusEl(err.message, "error"));
      textarea.disabled = submit.disabled = false;
    }
  });
  return { form, textarea };
}

/** Small pill buttons; `selected` marks a toggled choice (lens picker). */
function chip(label, onClick, className = "chip") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(b);
  });
  return b;
}

/** Lens picker: "Surprise me", presets, or any framework typed by the user. */
function lensPicker(onChange) {
  const wrap = document.createElement("div");
  wrap.className = "lens-picker";
  const label = document.createElement("div");
  label.className = "lens-label";
  label.textContent = "Explain it through…";
  const chips = document.createElement("div");
  chips.className = "chips";
  const select = (button, value) => {
    for (const b of chips.querySelectorAll(".chip")) b.classList.toggle("selected", b === button);
    onChange(value);
  };
  chips.append(
    chip("✨ Surprise me", (b) => select(b, "auto")),
    ...state.lenses.map((lens) => chip(lens, (b) => select(b, lens))),
  );
  const custom = document.createElement("input");
  custom.type = "text";
  custom.className = "lens-custom";
  custom.placeholder = "…or any framework, e.g. Kübler-Ross stages of grief";
  custom.addEventListener("input", () => {
    for (const b of chips.querySelectorAll(".chip")) b.classList.remove("selected");
    onChange(custom.value.trim() || null);
  });
  custom.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      wrap.closest("form, .card")?.querySelector("form")?.requestSubmit();
    }
  });
  wrap.append(label, chips, custom);
  return wrap;
}

/**
 * New thread composer. `action` sends a quick action right away; `lensOpen` starts with the
 * lens picker visible. A lens can be sent alone or with a typed question.
 */
function openComposer(anchor, { action = null, lensOpen = false } = {}) {
  const list = $("#threads");
  $(".card.composer", list)?.remove();
  $(".hint", list)?.remove();
  const card = document.createElement("div");
  card.className = "card composer";
  if (anchor) card.append(quoteEl(anchor));

  let lens = null;
  const send = async (body, shown) => {
    const live = liveAnswer();
    const pending = [statusEl(shown, "user"), live.el];
    form.before(...pending);
    for (const b of card.querySelectorAll("button, textarea, input")) b.disabled = true;
    let thread;
    try {
      thread = await apiStream(noteUrl("/threads"), { anchor, ...body }, live);
    } catch (err) {
      for (const el of pending) el.remove();
      for (const b of card.querySelectorAll("button, textarea, input")) b.disabled = false;
      throw err;
    }
    card.remove();
    state.current.sidecar.threads.push(thread);
    renderThreads();
    focusThread(thread.id, "card");
  };
  const sendAction = (a) =>
    send({ action: a.id }, a.label).catch((err) => form.before(statusEl(err.message, "error")));

  const picker = lensPicker((value) => {
    lens = value;
    textarea.placeholder = lens ? "Optional: what should it explain through this lens?" : placeholder;
  });
  picker.hidden = !lensOpen;
  const quick = document.createElement("div");
  quick.className = "chips quick-actions";
  quick.append(
    ...state.actions.filter((a) => a.id !== "angle").map((a) => chip(a.label, () => sendAction(a))),
    chip("Lens…", (b) => {
      picker.hidden = !picker.hidden;
      b.classList.toggle("selected", !picker.hidden);
    }, `chip${lensOpen ? " selected" : ""}`),
  );

  const placeholder = anchor ? "Ask about this passage…" : "Ask about the whole note…";
  const { form, textarea } = composeForm({
    placeholder,
    submitLabel: "Ask",
    allowEmpty: () => lens !== null,
    extra: inspectLink(() => ({ anchor, question: textarea.value.trim(), lens: lens ?? undefined })),
    onCancel: () => {
      card.remove();
      renderThreads();
    },
    onSubmit: (question) =>
      send(
        { question: question || undefined, lens: lens ?? undefined },
        question || (lens === "auto" ? "Connect this to a framework from another field." : `Explain this through ${lens}.`),
      ),
  });
  card.append(quick, picker, form);
  list.prepend(card);
  card.scrollIntoView({ block: "start", behavior: "smooth" });
  if (action) sendAction(state.actions.find((a) => a.id === action));
  else textarea.focus({ preventScroll: true });
}

function threadCard(thread, orphaned) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.thread = thread.id;
  card.addEventListener("click", (event) => {
    if (state.focusThreadId === thread.id || event.target.closest("a, button, textarea")) return;
    focusThread(thread.id, "passage");
  });
  if (orphaned) {
    const note = document.createElement("div");
    note.className = "orphan";
    note.textContent = "The passage this was about has changed.";
    card.append(note);
  } else if (!thread.anchor) {
    const note = document.createElement("div");
    note.className = "scope";
    note.textContent = "Whole note";
    card.append(note);
  }
  if (thread.lens) {
    const lensEl = document.createElement("div");
    lensEl.className = "lens-chip";
    lensEl.textContent = `Lens · ${thread.lens === "auto" ? "another field" : thread.lens}`;
    card.append(lensEl);
  }
  if (thread.anchor) card.append(quoteEl(thread.anchor));
  const list = document.createElement("div");
  list.className = "messages";
  list.append(...thread.messages.map((m, i) => messageEl(m, i, thread)));
  card.append(list);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link";
  remove.textContent = "Delete";
  remove.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!confirm("Delete this comment thread?")) return;
    state.current.sidecar = await api("DELETE", noteUrl(`/threads/${thread.id}`));
    renderThreads();
  });

  const sendReply = async (body, shown) => {
    const live = liveAnswer();
    const pending = [statusEl(shown, "user"), live.el];
    list.append(...pending);
    try {
      const updated = await apiStream(noteUrl(`/threads/${thread.id}/messages`), body, live);
      const threads = state.current.sidecar.threads;
      threads[threads.findIndex((t) => t.id === thread.id)] = updated;
      state.focusThreadId = thread.id;
      renderThreads();
    } catch (err) {
      for (const el of pending) el.remove();
      throw err;
    }
  };

  // One-click follow-ups for what users kept typing: "try another visualization", "do you disagree?"…
  const followups = document.createElement("div");
  followups.className = "chips followups";
  followups.append(
    ...["angle", "visualize", "challenge", "simplify"]
      .map((id) => state.actions.find((a) => a.id === id))
      .filter(Boolean)
      .map((a) =>
        chip(a.label, () => sendReply({ action: a.id }, a.label).catch((err) => list.append(statusEl(err.message, "error")))),
      ),
  );

  const { form, textarea } = composeForm({
    placeholder: "Reply, ask why, push back…",
    submitLabel: "Reply",
    extra: [remove, inspectLink(() => ({ threadId: thread.id, content: textarea.value.trim() }))],
    onSubmit: (content) => sendReply({ content }, content),
  });
  card.append(followups, form);
  return card;
}

/* ---------- context inspector ---------- */

function inspectLink(requestBody) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "link inspect";
  b.textContent = "What the AI sees";
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    openInspector(requestBody()).catch((err) => alert(err.message));
  });
  return b;
}

/** Show exactly what the next request sends — and to whom — before anything leaves the machine. */
async function openInspector(body) {
  const preview = await api("POST", noteUrl("/context-preview"), body);
  const dialog = $("#inspector");
  const out = $(".inspector-body", dialog);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const { destination: d } = preview;
  const summary = el("p", "inspector-summary");
  summary.append(
    "Sent to ",
    el("strong", "", d.endpoint ?? "nowhere (LLM not configured)"),
    ` · ${d.model ?? "no model"}${d.webSearch ? " · may search the web" : ""}${d.fast ? " · fast mode" : ""}`,
    el("br"),
    `About ${preview.approxTokens.toLocaleString()} tokens (${preview.characters.toLocaleString()} characters). `,
    "Nothing else from your vault leaves this machine.",
  );

  const vault = el("div", "inspector-section");
  vault.append(el("h3", "", `From your vault (${preview.related.length + 1} notes)`));
  const list = el("ul");
  list.append(el("li", "", `${state.current.title} — this note, in full`));
  for (const n of preview.related) {
    list.append(el("li", "", `${n.path.replace(/\.md$/i, "")} — ${n.relation}, excerpt of ${n.characters.toLocaleString()} characters`));
  }
  vault.append(list);

  const messages = el("div", "inspector-section");
  messages.append(el("h3", "", "The request"));
  for (const m of preview.messages) {
    const details = el("details", `inspector-message ${m.role}`);
    details.open = m.role !== "system";
    details.append(el("summary", "", `${m.role} · ${m.content.length.toLocaleString()} characters`), el("pre", "", m.content));
    messages.append(details);
  }
  out.replaceChildren(summary, vault, messages);
  dialog.showModal();
}

$("#inspector .close").addEventListener("click", () => $("#inspector").close());
$("#inspector").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close(); // backdrop click
});

/* ---------- selection → ask ---------- */

const selectionBar = $("#selection-bar");
let pendingAnchor = null;

function buildSelectionBar() {
  const act = (options) => () => {
    selectionBar.hidden = true;
    if (!pendingAnchor) return;
    openComposer(pendingAnchor, options);
    pendingAnchor = null;
    window.getSelection()?.removeAllRanges();
  };
  selectionBar.replaceChildren(
    chip("Ask…", act({}), "bar-button primary"),
    ...state.actions
      .filter((a) => a.id !== "angle")
      .map((a) => chip(a.label, act({ action: a.id }), "bar-button")),
    chip("Lens…", act({ lensOpen: true }), "bar-button"),
  );
}

document.addEventListener("mouseup", (event) => {
  if (selectionBar.contains(event.target)) return;
  // Let the browser finalize the selection first.
  setTimeout(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    const startBlock = selection?.anchorNode?.parentElement?.closest(".block");
    const endBlock = selection?.focusNode?.parentElement?.closest(".block");
    const inEmbed = selection?.anchorNode?.parentElement?.closest(".embed-body");
    if (!text || !startBlock || startBlock !== endBlock || inEmbed) {
      selectionBar.hidden = true;
      pendingAnchor = null;
      return;
    }
    pendingAnchor = { blockIndex: Number(startBlock.dataset.index), quote: text.slice(0, MAX_QUOTE) };
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    selectionBar.style.top = `${rect.bottom + window.scrollY + 6}px`;
    selectionBar.style.left = `${rect.left + window.scrollX}px`;
    selectionBar.hidden = false;
  }, 0);
});

selectionBar.addEventListener("mousedown", (event) => event.preventDefault());
$("#ask-note").addEventListener("click", () => openComposer(null));

/* ---------- routing ---------- */

async function route(notes) {
  const path = decodeURIComponent(location.hash.slice(1)) || notes[0];
  if (path) await openNote(path);
}

const [notes, catalog] = await Promise.all([loadSidebar(), api("GET", "/api/actions")]);
state.actions = catalog.actions;
state.lenses = catalog.lenses;
buildSelectionBar();
window.addEventListener("hashchange", () => route(notes).catch((err) => alert(err.message)));
await route(notes);
new EventSource("/api/events").addEventListener("change", (event) => onVaultChange(JSON.parse(event.data)));
