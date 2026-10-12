import {
  parseRecipe, serializeRecipe,
  slugify, inline, block, escapeHtml as esc, scaleLine,
  parseList, serializeList, listToText, textToList,
} from "./format.js";
import {
  CATEGORIES, categoryLabel, categoryColour, categoryOrder,
  parsePlace, serializePlace, placePath, hoursStatus, todayLine, osmHoursToLines,
} from "./places.js";

// ---- Config ---------------------------------------------------------------
// On GitHub Pages (owner.github.io/repo/) the repo is read from the URL;
// anywhere else (e.g. local testing) these defaults are used.
const DEFAULT_OWNER = "takayukispeed";
const DEFAULT_REPO = "recipe-book";
const BRANCH = "main";

const onPages = location.hostname.endsWith(".github.io");
const OWNER = onPages ? location.hostname.split(".")[0] : DEFAULT_OWNER;
const REPO = onPages ? location.pathname.split("/").filter(Boolean)[0] || DEFAULT_REPO : DEFAULT_REPO;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

const KEY_CACHE = "rb.files.v1";
const KEY_TOKEN = "rb.token";
const KEY_HINT = "rb.installHintDismissed";
const KEY_TICKS = "rb.staples.ticked";
const KEY_CITY = "rb.places.city";
const KEY_GEO = "rb.places.geo.v1";
const STAPLES = "lists/staples.md";

// ---- Storage (wrapped: private mode can make localStorage throw) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const state = {
  files: JSON.parse(store.get(KEY_CACHE) || "{}"), // path -> { sha, text }
  recipes: [],
  places: [],
  placeQuery: "",
  placeCat: null,
  placeOpenNow: false,
  placesMode: "list", // or "map"
  staples: { title: "Staples", sections: [] },
  query: "",
  tag: null,
  checked: {}, // path -> Set of ingredient indexes ticked off this session
  step: {}, // path -> index of the highlighted method step
  scale: {}, // path -> multiplier chosen this session
  syncing: false,
  syncError: null,
  lastSync: null,
};

const token = () => store.get(KEY_TOKEN) || "";

// ---- GitHub API -----------------------------------------------------------
async function gh(path, { method = "GET", body, accept } = {}) {
  const headers = { Accept: accept || "application/vnd.github+json" };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(API + path, {
    method, headers, cache: "no-store", body: body && JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* not JSON */ }
    const err = new Error(msg);
    err.status = res.status;
    err.rateLimited = (res.status === 403 || res.status === 429)
      && res.headers.get("x-ratelimit-remaining") === "0";
    throw err;
  }
  return res;
}

function friendlyError(err) {
  if (err.rateLimited) return "GitHub's limit for signed-out reads was hit. Add a token in Settings, or try again within the hour.";
  if (err.status === 401) return "The GitHub token was rejected. Check it in Settings.";
  if (err.status === 403 || err.status === 404) return "No permission. The token needs Contents: Read and write on this repo.";
  if (err.status === 409 || err.status === 422) return "The file changed on GitHub since you opened it. Sync, then redo the edit.";
  if (err instanceof TypeError) return "You appear to be offline.";
  return err.message || "Something went wrong.";
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

async function sync({ quiet = false } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  updateSyncButton();
  try {
    const tree = await (await gh(`/git/trees/${BRANCH}?recursive=1`)).json();
    const wanted = tree.tree.filter((e) => e.type === "blob" && /^((recipes|lists)\/[^/]+|places\/[^/]+\/[^/]+)\.md$/.test(e.path));
    const next = {};
    const todo = [];
    for (const e of wanted) {
      const cached = state.files[e.path];
      if (cached && cached.sha === e.sha) next[e.path] = cached;
      else todo.push(e);
    }
    await pool(todo, 6, async (e) => {
      const res = await gh(`/git/blobs/${e.sha}`, { accept: "application/vnd.github.raw+json" });
      next[e.path] = { sha: e.sha, text: await res.text() };
    });
    state.files = next;
    state.lastSync = new Date();
    persist();
    rebuild();
    safeRender();
    if (!quiet && todo.length) toast(`Updated ${todo.length} file${todo.length > 1 ? "s" : ""}`);
    state.syncError = null;
  } catch (err) {
    state.syncError = friendlyError(err);
    // Background syncs fail quietly when there's a cached copy to show.
    if (!quiet || !Object.keys(state.files).length) toast(state.syncError);
  } finally {
    state.syncing = false;
    updateSyncButton();
    if (!Object.keys(state.files).length) safeRender();
  }
}

async function saveFile(path, text, message) {
  const existing = state.files[path];
  const body = { message, content: toBase64(text), branch: BRANCH };
  if (existing) body.sha = existing.sha;
  const res = await gh(`/contents/${path}`, { method: "PUT", body });
  const json = await res.json();
  state.files[path] = { sha: json.content.sha, text };
  persist();
  rebuild();
}

async function deleteFile(path, message) {
  await gh(`/contents/${path}`, {
    method: "DELETE", body: { message, sha: state.files[path].sha, branch: BRANCH },
  });
  delete state.files[path];
  persist();
  rebuild();
}

function persist() { store.set(KEY_CACHE, JSON.stringify(state.files)); }

function rebuild() {
  const entries = Object.entries(state.files);
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  state.recipes = entries.filter(([p]) => p.startsWith("recipes/"))
    .map(([path, f]) => ({ path, ...parseRecipe(f.text) })).sort(byTitle);
  state.places = entries.filter(([p]) => p.startsWith("places/"))
    .map(([path, f]) => ({ path, ...parsePlace(f.text) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  state.staples = state.files[STAPLES] ? parseList(state.files[STAPLES].text) : { title: "Staples", sections: [] };
}

function uniquePath(folder, title) {
  const base = slugify(title);
  let path = `${folder}/${base}.md`;
  for (let n = 2; state.files[path]; n++) path = `${folder}/${base}-${n}.md`;
  return path;
}

// ---- UI helpers -----------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function updateSyncButton() {
  const btn = $("#sync");
  if (!btn) return;
  btn.disabled = state.syncing;
  btn.classList.toggle("spinning", state.syncing);
}

const ICON = {
  sync: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
};

const isStandalone = () => window.navigator.standalone === true
  || window.matchMedia("(display-mode: standalone)").matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

// ---- Views ----------------------------------------------------------------
function topBar(title) {
  return `<header class="bar">
      <h1>${title}</h1>
      <div class="bar-actions">
        <button id="sync" class="icon-btn" aria-label="Sync with GitHub">${ICON.sync}</button>
        <a class="icon-btn" href="#/settings" aria-label="Settings">${ICON.gear}</a>
      </div>
    </header>`;
}

function tabs(active) {
  const tab = (href, kind, label) => `<a href="${href}" class="${active === kind ? "on" : ""}">${label}</a>`;
  return `<nav class="segmented" aria-label="Section">
      ${tab("#/", "recipes", "Recipes")}${tab("#/staples", "staples", "Staples")}${tab("#/places", "places", "Places")}
    </nav>`;
}

// ---- Staples: the grocery-store list --------------------------------------
const loadTicks = () => { try { return new Set(JSON.parse(store.get(KEY_TICKS) || "[]")); } catch { return new Set(); } };
const saveTicks = (ticks) => store.set(KEY_TICKS, JSON.stringify([...ticks]));

function staplesView() {
  const list = state.staples;
  const ticks = loadTicks();
  const sectionNames = list.sections.map((s) => s.name).filter(Boolean);
  const loading = !state.lastSync && !Object.keys(state.files).length;

  app.innerHTML = `
    ${topBar("Staples")}
    ${tabs("staples")}
    <form id="add-form" class="add-row" ${token() ? "" : "hidden"}>
      <input id="staple-add" placeholder="Add an item…" autocomplete="off" enterkeyhint="done">
      <select id="staple-section" aria-label="Section">
        ${sectionNames.map((n) => `<option ${n === state.lastSection ? "selected" : ""}>${esc(n)}</option>`).join("")}
        <option value="__new">New section…</option>
      </select>
      <button class="add-btn" aria-label="Add">${ICON.plus}</button>
    </form>
    <input id="search" type="search" placeholder="Search staples" value="${esc(state.staplesQuery || "")}" autocomplete="off" autocorrect="off">
    <div id="results"></div>
    <div class="list-actions">
      <button id="clear-ticks" class="text-btn" hidden>Clear ticks</button>
      <a class="text-btn" href="#/edit/${STAPLES}">Edit list</a>
    </div>
  `;

  const show = () => {
    const q = (state.staplesQuery || "").trim().toLowerCase();
    const sections = list.sections
      .map((s) => ({ ...s, items: s.items.filter((i) => !q || i.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) }))
      .filter((s) => s.items.length);
    $("#results").innerHTML = sections.length ? sections.map((s) => `
      ${s.name ? `<h2 class="list-heading">${esc(s.name)}</h2>` : ""}
      <ul class="ingredients staples">${s.items.map((i) => `
        <li class="ing ${ticks.has(i) ? "done" : ""}" data-item="${esc(i)}"><span class="tick"></span><span>${inline(i)}</span></li>`).join("")}
      </ul>`).join("")
      : `<p class="empty">${list.sections.length ? "Nothing matches." : loading ? "Loading…" : "No staples yet. Add the things you buy often."}</p>`;
    $("#clear-ticks").hidden = !ticks.size;
    app.querySelectorAll(".staples .ing").forEach((li) => {
      li.onclick = (e) => {
        if (e.target.closest("a")) return;
        const item = li.dataset.item;
        ticks.has(item) ? ticks.delete(item) : ticks.add(item);
        saveTicks(ticks);
        li.classList.toggle("done");
        $("#clear-ticks").hidden = !ticks.size;
      };
    });
  };
  show();

  $("#sync").onclick = () => sync();
  updateSyncButton();
  $("#search").oninput = (e) => { state.staplesQuery = e.target.value; show(); };
  $("#clear-ticks").onclick = () => { ticks.clear(); saveTicks(ticks); show(); };

  const select = $("#staple-section");
  select.onchange = () => {
    if (select.value !== "__new") return;
    const name = (prompt("New section name (e.g. Dairy, Snacks, Household)") || "").trim();
    if (!name) { select.selectedIndex = 0; return; }
    const opt = new Option(name, name, true, true);
    select.insertBefore(opt, select.lastElementChild);
  };
  $("#add-form").onsubmit = (e) => {
    e.preventDefault();
    const input = $("#staple-add");
    const item = input.value.trim();
    const section = select.value === "__new" ? "" : select.value;
    if (!item) return;
    withBusy($(".add-btn"), async () => {
      const next = structuredClone(list);
      let s = next.sections.find((x) => x.name === section);
      if (!s) { s = { name: section, items: [] }; next.sections.push(s); }
      s.items.push(item);
      await saveFile(STAPLES, serializeList(next), `Add staple: ${item}`);
      state.lastSection = section;
      state.staplesQuery = "";
      toast(`Added ${item}`);
      render();
      $("#staple-add")?.focus();
    });
  };
}

function staplesEditor() {
  const list = state.staples;
  app.innerHTML = `
    ${backBar("#/staples", "Cancel", `<button class="text-btn strong" id="save" ${token() ? "" : "disabled"}>Save</button>`)}
    <form class="editor" onsubmit="return false">
      <h1>Edit staples</h1>
      ${tokenBanner()}
      ${area("list-text", "Items", listToText(list), "one per line · a line ending in : starts a section, e.g. Frozen:", 18)}
    </form>
  `;
  $("#save").onclick = () => withBusy($("#save"), async () => {
    const next = textToList($("#list-text").value, list.title);
    await saveFile(STAPLES, serializeList(next), "Update staples");
    // Drop ticks for items that no longer exist.
    const names = new Set(next.sections.flatMap((s) => s.items));
    saveTicks(new Set([...loadTicks()].filter((i) => names.has(i))));
    toast("Saved");
    location.hash = "#/staples";
  });
}

function listView() {
  const items = state.recipes;
  const tags = [...new Set(items.flatMap((i) => i.tags))].sort();
  if (state.tag && !tags.includes(state.tag)) state.tag = null;
  const showHint = isIOS() && !isStandalone() && !store.get(KEY_HINT);

  app.innerHTML = `
    ${topBar("Recipes")}
    ${showHint ? `<div class="hint"><span>Tap <strong>Share</strong> then <strong>Add to Home Screen</strong> to install this as an app.</span>
      <button id="hint-close" aria-label="Dismiss">✕</button></div>` : ""}
    ${tabs("recipes")}
    <input id="search" type="search" placeholder="Search titles, tags, ingredients"
      value="${esc(state.query)}" autocomplete="off" autocorrect="off">
    ${tags.length ? `<div class="chips">
      <button class="chip" data-tag="">All</button>
      ${tags.map((t) => `<button class="chip" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}
    </div>` : ""}
    <div id="results"></div>
    <a class="fab" href="#/new/recipe" aria-label="New recipe">${ICON.plus}</a>
  `;

  const card = (i) => `
    <li><a class="card" href="#/view/${esc(i.path)}">
      <span class="card-title">${esc(i.title)}</span>
      <span class="card-meta">
        <span class="badge ${i.type}">${i.type === "full" ? "Full method" : "Ingredients"}</span>
        ${i.serves ? `<span>Serves ${esc(i.serves.split("(")[0].trim())}</span>` : ""}
      </span>
      ${i.tags.length ? `<span class="card-tags">${i.tags.map(esc).join(" · ")}</span>` : ""}
    </a></li>`;

  const showResults = () => {
    const q = state.query.trim().toLowerCase();
    const matches = items.filter((i) => {
      if (state.tag && !i.tags.includes(state.tag)) return false;
      if (!q) return true;
      const hay = [i.title, ...i.tags, ...i.ingredients].join(" ").toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
    const loading = !state.lastSync && !Object.keys(state.files).length;
    const empty = items.length ? "Nothing matches."
      : loading && state.syncError ? `Couldn't load recipes. ${esc(state.syncError)}`
      : loading ? "Loading…" : `No recipes yet. Tap + to add one.`;
    $("#results").innerHTML = matches.length
      ? `<ul class="cards">${matches.map(card).join("")}</ul>`
      : `<p class="empty">${empty}</p>`;
    app.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", (c.dataset.tag || null) === state.tag));
  };
  showResults();

  $("#sync").onclick = () => sync();
  updateSyncButton();
  $("#hint-close")?.addEventListener("click", () => { store.set(KEY_HINT, "1"); render(); });
  $("#search").oninput = (e) => { state.query = e.target.value; showResults(); };
  app.querySelectorAll(".chip").forEach((c) => {
    c.onclick = () => { state.tag = c.dataset.tag || null; showResults(); };
  });
}

function backBar(href, label, right = "") {
  return `<header class="bar sub">
    <a class="back" href="${href}">${ICON.back}<span>${label}</span></a>
    <div class="bar-actions">${right}</div>
  </header>`;
}

function sourceHtml(src) {
  if (!src) return "";
  return /^https?:\/\//.test(src)
    ? `<a href="${esc(src)}" target="_blank" rel="noopener">${esc(new URL(src).hostname.replace(/^www\./, ""))}</a>`
    : inline(src);
}

function recipeView(r) {
  const checked = state.checked[r.path] ||= new Set();
  const step = state.step[r.path];
  const factor = state.scale[r.path] || 1;
  // Scaled amounts are wrapped in private-use markers by scaleLine, then highlighted.
  const scaled = (line) => inline(scaleLine(line, factor, { mark: true }))
    .replace(/\uE000/g, '<span class="scaled">').replace(/\uE001/g, "</span>");
  let n = 0;
  const ingredients = r.ingredients.map((line, i) => line.startsWith("#")
    ? `<li class="sub">${inline(line.replace(/^#+\s*/, ""))}</li>`
    : `<li class="ing ${checked.has(i) ? "done" : ""}" data-i="${i}"><span class="tick"></span><span>${scaled(line)}</span></li>`).join("");
  const SCALES = [[0.5, "½×"], [1, "1×"], [1.5, "1½×"], [2, "2×"], [3, "3×"]];
  const steps = r.method.map((line, i) => line.startsWith("#")
    ? `<li class="sub">${inline(line.replace(/^#+\s*/, ""))}</li>`
    : `<li class="step ${step === i ? "current" : ""}" data-i="${i}"><span class="num">${++n}</span><span>${inline(line)}</span></li>`).join("");

  app.innerHTML = `
    ${backBar("#/", "Recipes", `<a class="text-btn" href="#/edit/${esc(r.path)}">Edit</a>`)}
    <article class="recipe">
      <h1>${esc(r.title)}</h1>
      <p class="meta">
        <span class="badge ${r.type}">${r.type === "full" ? "Full method" : "Ingredients"}</span>
        ${r.serves ? `<span>Serves ${scaled(r.serves)}</span>` : ""}
        ${r.time ? `<span>${esc(r.time)}</span>` : ""}
      </p>
      ${r.intro ? `<div class="intro">${block(r.intro)}</div>` : ""}
      <section>
        <h2>Ingredients ${r.ingredients.length ? `<button id="reset" class="mini" ${checked.size ? "" : "hidden"}>Reset</button>` : ""}</h2>
        ${r.ingredients.length ? `<div class="scale" role="group" aria-label="Scale amounts">
          ${SCALES.map(([f, label]) => `<button data-f="${f}" class="${f === factor ? "on" : ""}" aria-pressed="${f === factor}">${label}</button>`).join("")}
        </div>` : ""}
        ${factor !== 1 && r.method.length ? `<p class="scale-note">Amounts mentioned in the method are for 1×.</p>` : ""}
        ${r.ingredients.length ? `<ul class="ingredients">${ingredients}</ul>` : `<p class="empty">None listed.</p>`}
      </section>
      ${r.method.length ? `<section><h2>Method</h2><ol class="steps">${steps}</ol></section>` : ""}
      ${r.notes ? `<section class="notes"><h2>Notes</h2>${block(r.notes)}</section>` : ""}
      ${r.source ? `<p class="source">Source: ${sourceHtml(r.source)}</p>` : ""}
      ${r.tags.length ? `<p class="tags">${r.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</p>` : ""}
      ${"wakeLock" in navigator ? `<label class="toggle"><input type="checkbox" id="wake" ${wakeLock ? "checked" : ""}> Keep screen on while cooking</label>` : ""}
    </article>
  `;

  app.querySelectorAll(".ing").forEach((li) => {
    li.onclick = (e) => {
      if (e.target.closest("a")) return;
      const i = Number(li.dataset.i);
      checked.has(i) ? checked.delete(i) : checked.add(i);
      li.classList.toggle("done");
      $("#reset").hidden = !checked.size;
    };
  });
  $("#reset")?.addEventListener("click", () => { checked.clear(); render(); });
  app.querySelectorAll(".scale button").forEach((b) => {
    b.onclick = () => { state.scale[r.path] = Number(b.dataset.f); render(); };
  });
  app.querySelectorAll(".step").forEach((li) => {
    li.onclick = (e) => {
      if (e.target.closest("a")) return;
      const i = Number(li.dataset.i);
      state.step[r.path] = state.step[r.path] === i ? undefined : i;
      app.querySelectorAll(".step").forEach((s) => s.classList.toggle("current", Number(s.dataset.i) === state.step[r.path]));
    };
  });
  $("#wake")?.addEventListener("change", (e) => setWakeLock(e.target.checked));
}

const field = (id, label, value, attrs = "") =>
  `<label class="field"><span>${label}</span><input id="${id}" value="${esc(value || "")}" ${attrs}></label>`;
const area = (id, label, value, hint, rows = 6) =>
  `<label class="field"><span>${label}${hint ? ` <small>${hint}</small>` : ""}</span>
    <textarea id="${id}" rows="${rows}">${esc(value || "")}</textarea></label>`;
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const tagList = (s) => [...new Set(s.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];


function tokenBanner() {
  return token() ? "" : `<p class="warn">To save changes, add a GitHub token in <a href="#/settings">Settings</a>.</p>`;
}

function recipeEditor(r) {
  const isNew = !r;
  r ||= { title: "", type: "quick", tags: [], serves: "", time: "", source: "", intro: "", ingredients: [], method: [], notes: "" };
  app.innerHTML = `
    ${backBar(isNew ? "#/" : `#/view/${esc(r.path)}`, "Cancel", `<button class="text-btn strong" id="save" ${token() ? "" : "disabled"}>Save</button>`)}
    <form class="editor" onsubmit="return false">
      <h1>${isNew ? "New recipe" : "Edit recipe"}</h1>
      ${tokenBanner()}
      ${field("title", "Title", r.title, 'required autocapitalize="words"')}
      <div class="field"><span>Kind</span>
        <div class="segmented small" role="radiogroup">
          <button type="button" data-type="quick" class="${r.type === "quick" ? "on" : ""}">Ingredients only</button>
          <button type="button" data-type="full" class="${r.type === "full" ? "on" : ""}">Full method</button>
        </div>
      </div>
      ${field("tags", "Tags <small>comma-separated</small>", r.tags.join(", "), 'autocapitalize="none"')}
      <div class="row">
        ${field("serves", "Serves", r.serves)}
        ${field("time", "Time", r.time)}
      </div>
      ${field("source", "Source <small>URL or book</small>", r.source, 'autocapitalize="none"')}
      ${area("ingredients", "Ingredients", r.ingredients.join("\n"), "one per line · e.g. 1 cup (240 mL) milk", 8)}
      <div id="method-wrap" ${r.type === "full" ? "" : "hidden"}>
        ${area("method", "Method", r.method.join("\n"), "one step per line", 10)}
      </div>
      ${area("intro", "Description", r.intro, "optional", 2)}
      ${area("notes", "Notes", r.notes, "optional", 4)}
      ${isNew ? "" : `<button type="button" id="delete" class="danger" ${token() ? "" : "disabled"}>Delete recipe</button>`}
    </form>
  `;
  let type = r.type;
  app.querySelectorAll("[data-type]").forEach((b) => {
    b.onclick = () => {
      type = b.dataset.type;
      app.querySelectorAll("[data-type]").forEach((x) => x.classList.toggle("on", x === b));
      $("#method-wrap").hidden = type !== "full";
    };
  });

  $("#save").onclick = () => withBusy($("#save"), async () => {
    const title = $("#title").value.trim();
    if (!title) { toast("Give it a title."); $("#title").focus(); return; }
    const next = {
      title, type,
      tags: tagList($("#tags").value),
      serves: $("#serves").value.trim(),
      time: $("#time").value.trim(),
      source: $("#source").value.trim(),
      intro: $("#intro").value.trim(),
      ingredients: lines($("#ingredients").value),
      method: type === "full" ? lines($("#method").value) : [],
      notes: $("#notes").value.trim(),
    };
    const path = isNew ? uniquePath("recipes", title) : r.path;
    await saveFile(path, serializeRecipe(next), `${isNew ? "Add" : "Update"} recipe: ${title}`);
    toast("Saved");
    location.hash = `#/view/${path}`;
  });

  $("#delete")?.addEventListener("click", () => {
    if (!confirm(`Delete "${r.title}"? It stays in the repo's history on GitHub.`)) return;
    withBusy($("#delete"), async () => {
      await deleteFile(r.path, `Delete recipe: ${r.title}`);
      toast("Deleted");
      location.hash = "#/";
    });
  });
}

async function withBusy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (err) { toast(friendlyError(err)); } finally { btn.disabled = false; }
}

function settingsView() {
  const repoUrl = `https://github.com/${OWNER}/${REPO}`;
  app.innerHTML = `
    ${backBar("#/", "Recipes")}
    <div class="editor">
      <h1>Settings</h1>
      <section class="panel">
        <h2>GitHub sync</h2>
        <p>Recipes live in <a href="${repoUrl}" target="_blank" rel="noopener">${OWNER}/${REPO}</a>.
          Reading works without signing in. To add or edit recipes, paste a GitHub token below. It is stored only on this device.</p>
        <label class="field"><span>Personal access token</span>
          <input id="token" type="password" value="${esc(token())}" autocomplete="off" autocapitalize="none" placeholder="github_pat_…"></label>
        <div class="buttons">
          <button id="save-token" class="primary">Save &amp; test</button>
          ${token() ? `<button id="clear-token">Remove</button>` : ""}
        </div>
        <p id="token-status" class="status"></p>
        <details>
          <summary>How to make a token</summary>
          <ol>
            <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Fine-grained tokens → Generate new token</a>.</li>
            <li>Under <em>Repository access</em> choose <strong>Only select repositories</strong> → <strong>${REPO}</strong>.</li>
            <li>Under <em>Permissions → Repository permissions</em> set <strong>Contents</strong> to <strong>Read and write</strong>.</li>
            <li>Pick an expiry, generate the token, and paste it here.</li>
          </ol>
        </details>
      </section>
      <section class="panel">
        <h2>Data</h2>
        <p>${state.recipes.length} recipes, ${state.places.length} places and ${state.staples.sections.reduce((n, s) => n + s.items.length, 0)} staples cached for offline use.
          ${state.lastSync ? `Last synced ${state.lastSync.toLocaleTimeString()}.` : ""}</p>
        <div class="buttons"><button id="resync">Re-download everything</button></div>
      </section>
    </div>
  `;
  const status = $("#token-status");
  $("#save-token").onclick = () => withBusy($("#save-token"), async () => {
    const value = $("#token").value.trim();
    if (!value) { status.textContent = "Paste a token first."; return; }
    store.set(KEY_TOKEN, value);
    status.textContent = "Testing…";
    try {
      const repo = await (await gh("")).json();
      status.textContent = repo.permissions?.push
        ? "✓ Connected. You can add and edit recipes."
        : "Token works but can't write to this repo. Check Contents: Read and write.";
    } catch (err) {
      status.textContent = friendlyError(err);
    }
  });
  $("#clear-token")?.addEventListener("click", () => { store.del(KEY_TOKEN); render(); toast("Token removed"); });
  $("#resync").onclick = () => { state.files = {}; persist(); rebuild(); sync(); toast("Re-downloading…"); };
}

function notFound() {
  app.innerHTML = `${backBar("#/", "Recipes")}<p class="empty">That page isn't here. It may have been renamed or deleted. Try syncing.</p>`;
}

// ---- Places: restaurants, cafés and bars by city --------------------------
const cities = () => [...new Set(state.places.map((p) => p.city).filter(Boolean))].sort((a, b) => a.localeCompare(b));
function currentCity() {
  const all = cities();
  const saved = store.get(KEY_CITY);
  return saved === "" || all.includes(saved) ? saved : all[0] || "";
}

const googleMaps = (p) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.name, p.address || p.city].filter(Boolean).join(", "))}`;
const directions = (p) => {
  const dest = p.address || `${p.name}, ${p.city}`;
  return isIOS() ? `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}&q=${encodeURIComponent(p.name)}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
};
const catBadge = (k) => `<span class="badge cat" style="--c:${categoryColour(k)}">${esc(categoryLabel(k))}</span>`;
const statusHtml = (p, cls = "") => {
  const s = hoursStatus(p.hours);
  return s ? `<span class="status-dot ${s.open ? "open" : "shut"} ${cls}">${esc(s.text)}</span>` : "";
};

// Coordinates: from the file when present (a GitHub Action fills them in), otherwise looked up
// on this device with OpenStreetMap's free geocoder and remembered.
const geoCache = () => { try { return JSON.parse(store.get(KEY_GEO) || "{}"); } catch { return {}; } };
const coords = (p) => (p.lat !== null && p.lng !== null ? [p.lat, p.lng] : geoCache()[p.address] || null);

async function nominatim(params) {
  const q = new URLSearchParams({ format: "jsonv2", limit: "1", ...params });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${q}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Map lookup failed (${res.status})`);
  return (await res.json())[0] || null;
}

let geocoding = false;
async function geocodeMissing(onFound) {
  if (geocoding) return;
  geocoding = true;
  try {
    const cache = geoCache();
    const todo = state.places.filter((p) => p.address && !coords(p) && !(p.address in cache));
    for (const p of todo) {
      try {
        const hit = await nominatim({ q: p.address.replace(/\s*\([^)]*\)/g, "") });
        cache[p.address] = hit ? [Number(hit.lat), Number(hit.lon)] : null;
        store.set(KEY_GEO, JSON.stringify(cache));
        if (hit) onFound(p);
      } catch { break; /* offline or rate-limited: try again next time */ }
      await new Promise((r) => setTimeout(r, 1100)); // Nominatim allows 1 request a second
    }
  } finally { geocoding = false; }
}

let leafletReady;
function loadLeaflet() {
  leafletReady ||= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.append(css);
    const js = document.createElement("script");
    js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletReady = null; reject(new Error("The map needs a connection to load.")); };
    document.head.append(js);
  });
  return leafletReady;
}

function filteredPlaces() {
  const city = currentCity();
  const q = state.placeQuery.trim().toLowerCase();
  return state.places.filter((p) => {
    if (city && p.city !== city) return false;
    if (state.placeCat && p.category !== state.placeCat) return false;
    if (state.placeOpenNow && !hoursStatus(p.hours)?.open) return false;
    if (!q) return true;
    const hay = [p.name, p.area, p.address, categoryLabel(p.category), p.notes].join(" ").toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}

function placesView() {
  const all = cities();
  const city = currentCity();
  const inCity = state.places.filter((p) => !city || p.city === city);
  const cats = CATEGORIES.map(([k]) => k).filter((k) => inCity.some((p) => p.category === k))
    .concat([...new Set(inCity.map((p) => p.category))].filter((k) => categoryOrder(k) === 99).sort());
  if (state.placeCat && !cats.includes(state.placeCat)) state.placeCat = null;
  const map = state.placesMode === "map";

  app.innerHTML = `
    ${topBar("Places")}
    ${tabs("places")}
    <div class="place-tools">
      ${all.length > 1 ? `<select id="city" aria-label="City">
        ${all.map((c) => `<option ${c === city ? "selected" : ""}>${esc(c)}</option>`).join("")}
        <option value="" ${city === "" ? "selected" : ""}>All cities</option>
      </select>` : all.length ? `<span class="city-name">${esc(all[0])}</span>` : ""}
      <div class="segmented small mode" role="group" aria-label="View">
        <button data-mode="list" class="${map ? "" : "on"}" aria-pressed="${!map}">List</button>
        <button data-mode="map" class="${map ? "on" : ""}" aria-pressed="${map}">Map</button>
      </div>
    </div>
    <input id="search" type="search" placeholder="Search names, neighbourhoods, notes"
      value="${esc(state.placeQuery)}" autocomplete="off" autocorrect="off">
    <div class="chips">
      <button class="chip ${state.placeOpenNow ? "on" : ""}" id="open-now">Open now</button>
      <button class="chip" data-cat="">All</button>
      ${cats.map((k) => `<button class="chip" data-cat="${esc(k)}">${esc(categoryLabel(k))}</button>`).join("")}
    </div>
    <div id="results"></div>
    <a class="fab" href="#/new/place" aria-label="New place">${ICON.plus}</a>
  `;

  const card = (p) => `
    <li><a class="card" href="#/view/${esc(p.path)}">
      <span class="card-title">${esc(p.name)}</span>
      <span class="card-meta">${catBadge(p.category)}${p.area ? `<span>${esc(p.area)}</span>` : ""}${!city && p.city ? `<span>${esc(p.city)}</span>` : ""}</span>
      ${statusHtml(p, "card-status")}
    </a></li>`;

  let mapObj = null;
  let markers = null;
  const drawMarkers = () => {
    if (!mapObj) return;
    const L = window.L;
    markers.clearLayers();
    const pts = [];
    for (const p of filteredPlaces()) {
      const c = coords(p);
      if (!c) continue;
      pts.push(c);
      const s = hoursStatus(p.hours);
      L.circleMarker(c, { radius: 9, color: "#fff", weight: 2, fillColor: categoryColour(p.category), fillOpacity: 1 })
        .bindPopup(`<a class="pop" href="#/view/${esc(p.path)}"><strong>${esc(p.name)}</strong></a><br>
          ${esc(categoryLabel(p.category))}${p.area ? ` · ${esc(p.area)}` : ""}${s ? `<br><span class="${s.open ? "open" : "shut"}">${esc(s.text)}</span>` : ""}`)
        .addTo(markers);
    }
    return pts;
  };
  const fit = (pts) => {
    if (pts?.length > 1) mapObj.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
    else if (pts?.length === 1) mapObj.setView(pts[0], 15);
  };

  const show = ({ refit = true } = {}) => {
    const matches = filteredPlaces();
    app.querySelectorAll("[data-cat]").forEach((c) => c.classList.toggle("on", (c.dataset.cat || null) === state.placeCat));
    if (map) {
      const missing = matches.filter((p) => !coords(p)).length;
      $("#map-note").textContent = missing ? `Finding ${missing} more on the map…` : "";
      const pts = drawMarkers();
      if (refit) fit(pts);
      return;
    }
    const loading = !state.lastSync && !Object.keys(state.files).length;
    if (!matches.length) {
      $("#results").innerHTML = `<p class="empty">${state.places.length ? "Nothing matches."
        : loading ? "Loading…" : "No places yet. Tap + to add one."}</p>`;
      return;
    }
    // Group by category in a fixed order.
    const groups = new Map();
    for (const p of [...matches].sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category))) {
      if (!groups.has(p.category)) groups.set(p.category, []);
      groups.get(p.category).push(p);
    }
    $("#results").innerHTML = [...groups].map(([k, ps]) => `
      ${state.placeCat ? "" : `<h2 class="list-heading">${esc(categoryLabel(k))}</h2>`}
      <ul class="cards">${ps.map(card).join("")}</ul>`).join("");
  };

  if (map) {
    $("#results").innerHTML = `<div id="map" class="map"></div><p id="map-note" class="map-note"></p>`;
    loadLeaflet().then((L) => {
      if (!document.getElementById("map")) return;
      mapObj = L.map("map", { zoomControl: false }).setView([45.52, -73.58], 12);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(mapObj);
      markers = L.layerGroup().addTo(mapObj);
      show();
      // Pins appear as they're found, without moving the map under your finger. If none were
      // known yet (a new city), zoom to them once the lookups finish.
      const hadPins = filteredPlaces().some(coords);
      geocodeMissing(() => { if (document.getElementById("map")) show({ refit: false }); })
        .then(() => { if (document.getElementById("map")) show({ refit: !hadPins }); });
    }).catch((err) => { $("#results").innerHTML = `<p class="empty">${esc(err.message)}</p>`; });
  } else show();

  $("#sync").onclick = () => sync();
  updateSyncButton();
  $("#city")?.addEventListener("change", (e) => { store.set(KEY_CITY, e.target.value); render(); });
  app.querySelectorAll("[data-mode]").forEach((b) => {
    b.onclick = () => { state.placesMode = b.dataset.mode; render(); };
  });
  $("#search").oninput = (e) => { state.placeQuery = e.target.value; show(); };
  $("#open-now").onclick = (e) => { state.placeOpenNow = !state.placeOpenNow; e.target.classList.toggle("on"); show(); };
  app.querySelectorAll("[data-cat]").forEach((c) => {
    c.onclick = () => { state.placeCat = c.dataset.cat || null; show(); };
  });
}

function placeView(p) {
  const today = todayLine(p.hours);
  const site = p.website && /^https?:\/\//.test(p.website) ? p.website : "";
  app.innerHTML = `
    ${backBar("#/places", "Places", `<a class="text-btn" href="#/edit/${esc(p.path)}">Edit</a>`)}
    <article class="recipe place">
      <h1>${esc(p.name)}</h1>
      <p class="meta">${catBadge(p.category)}${p.area ? `<span>${esc(p.area)}</span>` : ""}${p.city ? `<span>${esc(p.city)}</span>` : ""}</p>
      ${statusHtml(p, "big")}
      <div class="actions">
        <a href="${esc(directions(p))}" target="_blank" rel="noopener">${ICON.pin}<span>Directions</span></a>
        <a href="${esc(googleMaps(p))}" target="_blank" rel="noopener"><span class="g">G</span><span>Google Maps</span></a>
        ${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}"><span class="g">☎</span><span>Call</span></a>` : ""}
        ${site ? `<a href="${esc(site)}" target="_blank" rel="noopener"><span class="g">↗</span><span>Website</span></a>` : ""}
      </div>
      <section>
        <h2>Address</h2>
        <p class="address">${p.address ? esc(p.address) : "Not added yet."}${p.phone ? `<br><a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${esc(p.phone)}</a>` : ""}</p>
      </section>
      <section>
        <h2>Hours</h2>
        ${p.hours.length ? `<ul class="hours">${p.hours.map((h, i) => `<li class="${i === today ? "today" : ""}">${esc(h)}</li>`).join("")}</ul>`
          : `<p class="muted">No hours saved. <a href="${esc(googleMaps(p))}" target="_blank" rel="noopener">Check Google Maps</a>.</p>`}
        ${p.hours.length ? `<p class="fine">${p.checked ? `Checked ${esc(p.checked)}. ` : ""}Google Maps has the current hours, including holidays.</p>` : ""}
      </section>
      ${p.notes ? `<section class="notes"><h2>Notes</h2>${block(p.notes)}</section>` : ""}
    </article>
  `;
}

const HOURS_HINT = "one line per day or range · e.g. Mon–Fri: 11:30–22:00 · Sat: 10:00–14:00, 17:00–23:00 · Sun: Closed";

function placeEditor(p) {
  const isNew = !p;
  const city = currentCity();
  p ||= { name: "", city, category: state.placeCat || "nice", area: "", address: "", phone: "", website: "", lat: null, lng: null, checked: "", hours: [], notes: "" };
  const cats = CATEGORIES.some(([k]) => k === p.category) ? CATEGORIES : [...CATEGORIES, [p.category, p.category]];
  app.innerHTML = `
    ${backBar(isNew ? "#/places" : `#/view/${esc(p.path)}`, "Cancel", `<button class="text-btn strong" id="save" ${token() ? "" : "disabled"}>Save</button>`)}
    <form class="editor" onsubmit="return false">
      <h1>${isNew ? "New place" : "Edit place"}</h1>
      ${tokenBanner()}
      ${field("name", "Name", p.name, 'required autocapitalize="words"')}
      <label class="field"><span>Category</span><select id="category">
        ${cats.map(([k, label]) => `<option value="${esc(k)}" ${k === p.category ? "selected" : ""}>${esc(label)}</option>`).join("")}
      </select></label>
      <div class="row">
        ${field("city", "City", p.city, 'autocapitalize="words" list="city-list"')}
        ${field("area", "Neighbourhood", p.area, 'autocapitalize="words"')}
      </div>
      <datalist id="city-list">${cities().map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      ${field("address", "Address", p.address)}
      <div class="buttons lookup"><button type="button" id="lookup">Look up on OpenStreetMap</button></div>
      <p id="lookup-status" class="status"></p>
      <div class="row">
        ${field("phone", "Phone", p.phone, 'type="tel"')}
        ${field("website", "Website", p.website, 'type="url" autocapitalize="none"')}
      </div>
      ${area("hours", "Hours", p.hours.join("\n"), HOURS_HINT, 7)}
      ${area("notes", "Notes", p.notes, "what to order, who it's good for…", 4)}
      <div class="row">
        ${field("lat", "Latitude <small>for the map</small>", String(p.lat ?? ""), 'inputmode="decimal"')}
        ${field("lng", "Longitude", String(p.lng ?? ""), 'inputmode="decimal"')}
      </div>
      ${isNew ? "" : `<button type="button" id="delete" class="danger" ${token() ? "" : "disabled"}>Delete place</button>`}
    </form>
  `;

  // Fill blanks from OpenStreetMap: coordinates always, plus address, phone, website and hours when it has them.
  $("#lookup").onclick = () => withBusy($("#lookup"), async () => {
    const status = $("#lookup-status");
    const name = $("#name").value.trim();
    const where = $("#city").value.trim();
    const addr = $("#address").value.trim();
    if (!name && !addr) { status.textContent = "Enter a name or an address first."; return; }
    status.textContent = "Searching…";
    let hit = name ? await nominatim({ q: [name, where].filter(Boolean).join(", "), extratags: "1", addressdetails: "1" }) : null;
    if (!hit && addr) hit = await nominatim({ q: addr, extratags: "1", addressdetails: "1" });
    if (!hit) { status.textContent = "Not found. Check the spelling, or type the address and try again."; return; }
    const filled = [];
    const set = (id, value, label) => { if (value && !$(id).value.trim()) { $(id).value = value; filled.push(label); } };
    const a = hit.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(" ");
    set("#address", [street, a.city || a.town || a.village, a.state, a.postcode].filter(Boolean).join(", "), "address");
    set("#area", a.neighbourhood || a.suburb || "", "neighbourhood");
    set("#phone", hit.extratags?.phone || hit.extratags?.["contact:phone"], "phone");
    set("#website", hit.extratags?.website || hit.extratags?.["contact:website"], "website");
    set("#hours", osmHoursToLines(hit.extratags?.opening_hours).join("\n"), "hours");
    $("#lat").value = Number(hit.lat).toFixed(6);
    $("#lng").value = Number(hit.lon).toFixed(6);
    filled.push("map location");
    status.textContent = `Found: ${hit.display_name.split(",").slice(0, 3).join(",")}. Filled in ${filled.join(", ")}. Check that it's the right place.`;
  });

  $("#save").onclick = () => withBusy($("#save"), async () => {
    const name = $("#name").value.trim();
    if (!name) { toast("Give it a name."); $("#name").focus(); return; }
    const num = (id) => { const v = $(id).value.trim(); return v && Number.isFinite(Number(v)) ? Number(v) : null; };
    const next = {
      name,
      city: $("#city").value.trim(),
      category: $("#category").value,
      area: $("#area").value.trim(),
      address: $("#address").value.trim(),
      phone: $("#phone").value.trim(),
      website: $("#website").value.trim(),
      lat: num("#lat"),
      lng: num("#lng"),
      hours: lines($("#hours").value),
      notes: $("#notes").value.trim(),
    };
    // A new address with the old coordinates would put the pin in the wrong spot; clearing them
    // lets the map look the address up again.
    if (!isNew && next.address !== p.address && next.lat === p.lat && next.lng === p.lng) next.lat = next.lng = null;
    const changedHours = isNew || next.hours.join("\n") !== p.hours.join("\n") || next.address !== p.address;
    next.checked = changedHours ? new Date().toISOString().slice(0, 7) : p.checked;
    const folder = placePath(next);
    const path = isNew || !p.path.startsWith(`${folder}/`) ? uniquePath(folder, name) : p.path;
    await saveFile(path, serializePlace(next), `${isNew ? "Add" : "Update"} place: ${name}`);
    if (!isNew && path !== p.path) await deleteFile(p.path, `Move place: ${name}`); // city changed
    if (next.city) store.set(KEY_CITY, next.city);
    toast("Saved");
    location.hash = `#/view/${path}`;
  });

  $("#delete")?.addEventListener("click", () => {
    if (!confirm(`Delete "${p.name}"? It stays in the repo's history on GitHub.`)) return;
    withBusy($("#delete"), async () => {
      await deleteFile(p.path, `Delete place: ${p.name}`);
      toast("Deleted");
      location.hash = "#/places";
    });
  });
}

// ---- Wake lock (keep screen on while cooking) -----------------------------
let wakeLock = null;
let wantWake = false;
async function setWakeLock(on) {
  wantWake = on;
  try {
    if (on && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    toast("Couldn't keep the screen on.");
    const box = $("#wake");
    if (box) box.checked = false;
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wantWake && location.hash.startsWith("#/view/recipes/")) setWakeLock(true);
});

// ---- Router ---------------------------------------------------------------
let lastRoute = "";
function render() {
  const route = decodeURIComponent(location.hash.slice(1) || "/");
  if (route !== lastRoute) {
    if (!route.startsWith("/view/recipes/") && wakeLock) setWakeLock(false);
    window.scrollTo(0, 0);
    lastRoute = route;
  }
  const find = (path) => state.recipes.find((r) => r.path === path);
  let m;
  if (route === "/" || route === "") return listView();
  if (route === "/staples") return staplesView();
  if (route === `/edit/${STAPLES}`) return staplesEditor();
  if (route === "/settings") return settingsView();
  if (route === "/new/recipe") return recipeEditor(null);
  if (route === "/places") return placesView();
  if (route === "/new/place") return placeEditor(null);
  if ((m = route.match(/^\/(view|edit)\/(places\/.+)$/))) {
    const place = state.places.find((p) => p.path === m[2]);
    if (!place) return state.lastSync ? notFound() : (app.innerHTML = '<p class="empty">Loading…</p>');
    return m[1] === "view" ? placeView(place) : placeEditor(place);
  }
  if ((m = route.match(/^\/view\/(.+)$/))) {
    const item = find(m[1]);
    if (!item) return state.lastSync ? notFound() : (app.innerHTML = '<p class="empty">Loading…</p>');
    return recipeView(item);
  }
  if ((m = route.match(/^\/edit\/(.+)$/))) {
    const item = find(m[1]);
    if (!item) return notFound();
    return recipeEditor(item);
  }
  return notFound();
}

// Background syncs must not redraw over a form someone is typing in.
const editing = () => /^#\/(edit|new)\//.test(location.hash) || location.hash === "#/settings"
  || (document.activeElement?.id === "staple-add" && document.activeElement.value);
function safeRender() { if (!editing()) render(); }

window.addEventListener("hashchange", render);
rebuild();
render();
sync({ quiet: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !editing()) sync({ quiet: true });
});

// ---- App updates ----------------------------------------------------------
// Check for a new version whenever the app comes to the foreground; when one takes over,
// reload so the new code runs (unless a form is open, in which case the next open picks it up).
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then((reg) => {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    })
    .catch(() => { /* offline support is optional */ });
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded || editing()) return;
    reloaded = true;
    location.reload();
  });
}
