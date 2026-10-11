import {
  parseRecipe, serializeRecipe, parseMeal, serializeMeal,
  slugify, inline, block, escapeHtml as esc, scaleLine,
} from "./format.js";

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

// ---- Storage (wrapped: private mode can make localStorage throw) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const state = {
  files: JSON.parse(store.get(KEY_CACHE) || "{}"), // path -> { sha, text }
  recipes: [],
  meals: [],
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
    const wanted = tree.tree.filter((e) => e.type === "blob" && /^(recipes|meals)\/[^/]+\.md$/.test(e.path));
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
  state.meals = entries.filter(([p]) => p.startsWith("meals/"))
    .map(([path, f]) => ({ path, ...parseMeal(f.text) })).sort(byTitle);
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
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
};

const isStandalone = () => window.navigator.standalone === true
  || window.matchMedia("(display-mode: standalone)").matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

// ---- Views ----------------------------------------------------------------
function listView(kind) {
  const isMeals = kind === "meals";
  const items = isMeals ? state.meals : state.recipes;
  const tags = [...new Set(items.flatMap((i) => i.tags))].sort();
  if (state.tag && !tags.includes(state.tag)) state.tag = null;
  const showHint = isIOS() && !isStandalone() && !store.get(KEY_HINT);

  app.innerHTML = `
    <header class="bar">
      <h1>${isMeals ? "Meals" : "Recipes"}</h1>
      <div class="bar-actions">
        <button id="sync" class="icon-btn" aria-label="Sync with GitHub">${ICON.sync}</button>
        <a class="icon-btn" href="#/settings" aria-label="Settings">${ICON.gear}</a>
      </div>
    </header>
    ${showHint ? `<div class="hint"><span>Tap <strong>Share</strong> then <strong>Add to Home Screen</strong> to install this as an app.</span>
      <button id="hint-close" aria-label="Dismiss">✕</button></div>` : ""}
    <nav class="segmented" aria-label="Section">
      <a href="#/" class="${isMeals ? "" : "on"}">Recipes</a>
      <a href="#/meals" class="${isMeals ? "on" : ""}">Meals</a>
    </nav>
    <input id="search" type="search" placeholder="Search ${isMeals ? "meals" : "titles, tags, ingredients"}"
      value="${esc(state.query)}" autocomplete="off" autocorrect="off">
    ${tags.length ? `<div class="chips">
      <button class="chip" data-tag="">All</button>
      ${tags.map((t) => `<button class="chip" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}
    </div>` : ""}
    <div id="results"></div>
    <a class="fab" href="#/new/${isMeals ? "meal" : "recipe"}" aria-label="New ${isMeals ? "meal" : "recipe"}">${ICON.plus}</a>
  `;

  const card = (i) => `
    <li><a class="card" href="#/view/${esc(i.path)}">
      <span class="card-title">${esc(i.title)}</span>
      <span class="card-meta">
        ${isMeals ? `${i.components.length} component${i.components.length === 1 ? "" : "s"}`
          : `<span class="badge ${i.type}">${i.type === "full" ? "Full method" : "Ingredients"}</span>
             ${i.serves ? `<span>Serves ${esc(i.serves.split("(")[0].trim())}</span>` : ""}`}
      </span>
      ${i.tags.length ? `<span class="card-tags">${i.tags.map(esc).join(" · ")}</span>` : ""}
    </a></li>`;

  const showResults = () => {
    const q = state.query.trim().toLowerCase();
    const matches = items.filter((i) => {
      if (state.tag && !i.tags.includes(state.tag)) return false;
      if (!q) return true;
      const hay = [i.title, ...i.tags, ...(i.ingredients || []), ...(i.components || [])].join(" ").toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
    const loading = !state.lastSync && !Object.keys(state.files).length;
    const empty = items.length ? "Nothing matches."
      : loading && state.syncError ? `Couldn't load recipes. ${esc(state.syncError)}`
      : loading ? "Loading…" : `No ${kind} yet. Tap + to add one.`;
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

function mealView(m) {
  app.innerHTML = `
    ${backBar("#/meals", "Meals", `<a class="text-btn" href="#/edit/${esc(m.path)}">Edit</a>`)}
    <article class="recipe">
      <h1>${esc(m.title)}</h1>
      ${m.intro ? `<div class="intro">${block(m.intro)}</div>` : ""}
      <section><h2>Components</h2>
        ${m.components.length ? `<ul class="components">${m.components.map((c) => `<li>${inline(c)}</li>`).join("")}</ul>`
          : `<p class="empty">None listed.</p>`}
      </section>
      ${m.notes ? `<section class="notes"><h2>Notes</h2>${block(m.notes)}</section>` : ""}
      ${m.tags.length ? `<p class="tags">${m.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</p>` : ""}
    </article>
  `;
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

function mealEditor(m) {
  const isNew = !m;
  m ||= { title: "", tags: [], intro: "", components: [], notes: "" };
  app.innerHTML = `
    ${backBar(isNew ? "#/meals" : `#/view/${esc(m.path)}`, "Cancel", `<button class="text-btn strong" id="save" ${token() ? "" : "disabled"}>Save</button>`)}
    <form class="editor" onsubmit="return false">
      <h1>${isNew ? "New meal" : "Edit meal"}</h1>
      ${tokenBanner()}
      ${field("title", "Title", m.title, 'required autocapitalize="words"')}
      ${field("tags", "Tags <small>comma-separated</small>", m.tags.join(", "), 'autocapitalize="none"')}
      <label class="field"><span>Add a recipe</span>
        <select id="add-recipe"><option value="">Choose…</option>
          ${state.recipes.map((r) => `<option value="${esc(r.path)}">${esc(r.title)}</option>`).join("")}
        </select></label>
      ${area("components", "Components", m.components.join("\n"), "one per line · free text or recipes added above", 6)}
      ${area("notes", "Notes", m.notes, "optional", 4)}
      ${isNew ? "" : `<button type="button" id="delete" class="danger" ${token() ? "" : "disabled"}>Delete meal</button>`}
    </form>
  `;
  $("#add-recipe").onchange = (e) => {
    const r = state.recipes.find((x) => x.path === e.target.value);
    if (!r) return;
    const ta = $("#components");
    ta.value = [...lines(ta.value), `[${r.title.replace(/[[\]]/g, "")}](../${r.path})`].join("\n");
    e.target.value = "";
  };
  $("#save").onclick = () => withBusy($("#save"), async () => {
    const title = $("#title").value.trim();
    if (!title) { toast("Give it a title."); $("#title").focus(); return; }
    const next = {
      title, tags: tagList($("#tags").value), intro: m.intro,
      components: lines($("#components").value), notes: $("#notes").value.trim(),
    };
    const path = isNew ? uniquePath("meals", title) : m.path;
    await saveFile(path, serializeMeal(next), `${isNew ? "Add" : "Update"} meal: ${title}`);
    toast("Saved");
    location.hash = `#/view/${path}`;
  });
  $("#delete")?.addEventListener("click", () => {
    if (!confirm(`Delete "${m.title}"?`)) return;
    withBusy($("#delete"), async () => {
      await deleteFile(m.path, `Delete meal: ${m.title}`);
      toast("Deleted");
      location.hash = "#/meals";
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
        <p>${state.recipes.length} recipes and ${state.meals.length} meals cached for offline use.
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
  app.innerHTML = `${backBar("#/", "Recipes")}<p class="empty">That recipe isn't here. It may have been renamed or deleted. Try syncing.</p>`;
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
  const find = (path) => state.recipes.find((r) => r.path === path) || state.meals.find((m) => m.path === path);
  let m;
  if (route === "/" || route === "") return listView("recipes");
  if (route === "/meals") return listView("meals");
  if (route === "/settings") return settingsView();
  if (route === "/new/recipe") return recipeEditor(null);
  if (route === "/new/meal") return mealEditor(null);
  if ((m = route.match(/^\/view\/(.+)$/))) {
    const item = find(m[1]);
    if (!item) return state.lastSync ? notFound() : (app.innerHTML = '<p class="empty">Loading…</p>');
    return item.path.startsWith("meals/") ? mealView(item) : recipeView(item);
  }
  if ((m = route.match(/^\/edit\/(.+)$/))) {
    const item = find(m[1]);
    if (!item) return notFound();
    return item.path.startsWith("meals/") ? mealEditor(item) : recipeEditor(item);
  }
  return notFound();
}

// Background syncs must not redraw over a form someone is typing in.
const editing = () => /^#\/(edit|new)\//.test(location.hash) || location.hash === "#/settings";
function safeRender() { if (!editing()) render(); }

window.addEventListener("hashchange", render);
rebuild();
render();
sync({ quiet: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !editing()) sync({ quiet: true });
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* offline support is optional */ });
}
