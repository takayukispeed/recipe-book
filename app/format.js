// Parse and serialize the Markdown recipe/meal files used in recipes/ and meals/.
// Shared by the app (browser) and tests (Node).

export function parseFrontMatter(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const meta = {};
  if (lines[0]?.trim() !== "---") return { meta, body: lines.join("\n") };
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((v) => v.trim()).filter(Boolean);
    }
    meta[key] = value;
  }
  return { meta, body: lines.slice(i + 1).join("\n") };
}

// Split a body into { title, intro, sections: {lowercased heading: text} }.
function splitSections(body) {
  const lines = body.split("\n");
  let title = "";
  const intro = [];
  const sections = {};
  let current = null;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    if (h1 && !title && current === null) { title = h1[1].trim(); continue; }
    if (h2) { current = h2[1].trim().toLowerCase(); sections[current] = []; continue; }
    (current === null ? intro : sections[current]).push(line);
  }
  const clean = (arr) => arr.join("\n").trim();
  const out = {};
  for (const [k, v] of Object.entries(sections)) out[k] = clean(v);
  return { title, intro: clean(intro), sections: out };
}

// Turn "- a\n- b" or "1. a\n2. b" into one item per line, keeping "### sub" headings.
export function listItems(text) {
  return (text || "").split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "-" && !/^\d+\.$/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""));
}

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

export function parseRecipe(text) {
  const { meta, body } = parseFrontMatter(text);
  const { title, intro, sections } = splitSections(body);
  return {
    title: meta.title || title || "Untitled",
    type: meta.type === "full" ? "full" : "quick",
    tags: asList(meta.tags),
    serves: typeof meta.serves === "string" ? meta.serves : "",
    time: typeof meta.time === "string" ? meta.time : "",
    source: typeof meta.source === "string" ? meta.source : "",
    intro,
    ingredients: listItems(sections.ingredients),
    method: listItems(sections.method),
    notes: sections.notes || "",
  };
}

const fm = (key, value) => `${key}: ${value ?? ""}`.trimEnd();

export function serializeRecipe(r) {
  const out = [
    "---",
    fm("title", r.title),
    fm("type", r.type === "full" ? "full" : "quick"),
    fm("tags", `[${(r.tags || []).join(", ")}]`),
    fm("serves", r.serves),
  ];
  if (r.type === "full" || r.time) out.push(fm("time", r.time));
  out.push(fm("source", r.source), "---", "", `# ${r.title}`, "");
  if (r.intro?.trim()) out.push(r.intro.trim(), "");
  out.push("## Ingredients", "");
  for (const i of r.ingredients || []) out.push(i.startsWith("#") ? `\n${i}\n` : `- ${i}`);
  out.push("");
  if (r.type === "full" || r.method?.length) {
    out.push("## Method", "");
    let n = 0;
    for (const s of r.method || []) out.push(s.startsWith("#") ? `\n${s}\n` : `${++n}. ${s}`);
    out.push("");
  }
  out.push("## Notes", "");
  if (r.notes?.trim()) out.push(r.notes.trim(), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function parseMeal(text) {
  const { meta, body } = parseFrontMatter(text);
  const { title, intro, sections } = splitSections(body);
  return {
    title: meta.title || title || "Untitled meal",
    tags: asList(meta.tags),
    intro,
    components: listItems(sections.components),
    notes: sections.notes || "",
  };
}

export function serializeMeal(m) {
  const out = ["---", fm("title", m.title), fm("tags", `[${(m.tags || []).join(", ")}]`), "---", "", `# ${m.title}`, ""];
  if (m.intro?.trim()) out.push(m.intro.trim(), "");
  out.push("## Components", "");
  for (const c of m.components || []) out.push(`- ${c}`);
  out.push("", "## Notes", "");
  if (m.notes?.trim()) out.push(m.notes.trim(), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function slugify(title) {
  return title.toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Minimal inline Markdown: links, **bold**, *italic* / _italic_. Output is HTML-safe.
export function inline(md) {
  const links = [];
  let s = (md || "").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    links.push({ text, url });
    return `\u0000${links.length - 1}\u0000`;
  });
  s = escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=$|[\s).,;:!?])/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_(?!\s)(.+?)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const { text, url } = links[Number(i)];
    const local = url.match(/^(?:\.\.\/)?((?:recipes|meals)\/[\w.-]+\.md)$/);
    if (local) return `<a href="#/view/${local[1]}">${escapeHtml(text)}</a>`;
    if (/^https?:\/\//.test(url)) {
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
    }
    return escapeHtml(text);
  });
}

// Paragraphs and "- " lists for intro/notes blocks.
export function block(md) {
  const html = [];
  let list = null;
  for (const raw of (md || "").split("\n")) {
    const line = raw.trim();
    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) { (list ??= []).push(`<li>${inline(item[1])}</li>`); continue; }
    if (list) { html.push(`<ul>${list.join("")}</ul>`); list = null; }
    if (line) html.push(`<p>${inline(line)}</p>`);
  }
  if (list) html.push(`<ul>${list.join("")}</ul>`);
  return html.join("");
}

export { escapeHtml };

// ---- Scaling --------------------------------------------------------------
// Scales the quantities in one ingredient line by `factor`:
//  • the number that starts the line ("8 corn tortillas", "½ red onion"), and
//  • any number followed by a unit anywhere in the line ("(240 mL)", "2 tsp").
// Bare numbers mid-line ("cut into 4") and dimensions ("2-inch (5 cm)") are left alone.
const FRACS = { "½": 1 / 2, "¼": 1 / 4, "¾": 3 / 4, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8 };
const FC = Object.keys(FRACS).join("");
const NUM = `\\d+(?:\\.\\d+)?\\s?[${FC}]|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?|[${FC}]`;
const UNITS = "cups?|tbsps?|tablespoons?|tsps?|teaspoons?|lbs?|pounds?|oz|ounces?|kg|g|grams?|ml|l|litres?|liters?"
  + "|cans?|sheets?|cloves?|slices?|bags?|boxes|box|bunch(?:es)?|sprigs?|stalks?|heads?|pinch(?:es)?|sticks?|packages?|jars?|bottles?";
const QTY = new RegExp(`(^|[^\\w.\\/])(${NUM})(?:(\\s*[–-]\\s*)(${NUM}))?(?:(\\s*)(${UNITS})(?![\\w]))?`, "gi");
const PLURALS = {
  cup: "cups", can: "cans", sheet: "sheets", clove: "cloves", slice: "slices", bag: "bags", box: "boxes",
  bunch: "bunches", sprig: "sprigs", stalk: "stalks", head: "heads", pinch: "pinches", stick: "sticks",
  package: "packages", jar: "jars", bottle: "bottles",
};
const SINGULARS = Object.fromEntries(Object.entries(PLURALS).map(([s, p]) => [p, s]));

export function parseNumber(s) {
  s = s.trim();
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s?([^\d\s])$/)) && FRACS[m[2]]) return Number(m[1]) + FRACS[m[2]];
  if ((m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/))) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  if ((m = s.match(/^(\d+)\/(\d+)$/))) return Number(m[1]) / Number(m[2]);
  if (FRACS[s]) return FRACS[s];
  return Number(s);
}

function fraction(v) {
  if (v >= 10) return String(Math.round(v * 2) / 2).replace(/\.5$/, "½");
  const opts = [[0, ""], [1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [3 / 8, "⅜"], [1 / 2, "½"], [5 / 8, "⅝"], [2 / 3, "⅔"], [3 / 4, "¾"], [7 / 8, "⅞"], [1, ""]];
  let whole = Math.floor(v);
  const rem = v - whole;
  let [val, sym] = opts.reduce((best, o) => (Math.abs(o[0] - rem) < Math.abs(best[0] - rem) ? o : best));
  if (val === 1) whole += 1;
  if (!whole && !sym) return "⅛";
  return `${whole || ""}${sym}`;
}

const trim = (v) => String(Math.round(v * 10) / 10);
const isMetric = (u) => /^(g|grams?|kg|ml|l|litres?|liters?)$/i.test(u || "");

function metric(v, unit) {
  const u = unit.toLowerCase();
  const small = /^(g|grams?|ml)$/.test(u);
  if (small) {
    if (v < 1) return trim(v);
    if (v < 10) return String(Math.round(v * 2) / 2);
    if (v < 100) return String(Math.round(v / 5) * 5);
    return String(Math.round(v / 10) * 10);
  }
  return v < 10 ? trim(v) : String(Math.round(v));
}

export function scaleLine(line, factor, { mark = false } = {}) {
  if (factor === 1) return line;
  const wrap = (s) => (mark ? `${s}` : s);
  return line.replace(QTY, (m, pre, a, sep, b, sp, unit, offset) => {
    const leading = offset === 0 && pre === "";
    if (!unit && !leading) return m;
    let lo = parseNumber(a) * factor;
    let hi = b !== undefined ? parseNumber(b) * factor : null;
    let u = unit || "";
    let fmt;
    if (isMetric(u)) {
      // 1200 g → 1.2 kg, 1080 mL → 1.1 L
      if (/^(g|grams?|ml)$/i.test(u) && (hi ?? lo) >= 1000) {
        lo /= 1000; if (hi !== null) hi /= 1000;
        u = /^ml$/i.test(u) ? "L" : "kg";
      }
      fmt = (v) => metric(v, u);
    } else if (a.includes(".") || (b || "").includes(".")) {
      fmt = trim;
    } else {
      fmt = fraction;
    }
    const lower = u.toLowerCase();
    const many = (hi ?? lo) > 1;
    if (many && PLURALS[lower]) u = PLURALS[lower];
    if (!many && SINGULARS[lower]) u = SINGULARS[lower];
    const qty = hi !== null ? `${fmt(lo)}${sep}${fmt(hi)}` : fmt(lo);
    return `${pre}${wrap(`${qty}${unit ? sp + u : ""}`)}`;
  });
}

// ---- Lists (e.g. lists/staples.md) ----------------------------------------
// "## Section" headings, each followed by "- item" lines.
export function parseList(text) {
  const { meta, body } = parseFrontMatter(text);
  const sections = [];
  let current = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const h = line.match(/^##\s+(.*)$/);
    if (h) { current = { name: h[1].trim(), items: [] }; sections.push(current); continue; }
    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) {
      if (!current) { current = { name: "", items: [] }; sections.push(current); }
      current.items.push(item[1].trim());
    }
  }
  return { title: meta.title || "Staples", sections };
}

export function serializeList(list) {
  const out = ["---", fm("title", list.title), "---", "", `# ${list.title}`, ""];
  for (const s of list.sections) {
    if (!s.items.length) continue;
    if (s.name) out.push(`## ${s.name}`, "");
    for (const i of s.items) out.push(`- ${i}`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// Plain-text form used by the list editor: a line ending in ":" starts a section.
export function listToText(list) {
  return list.sections.map((s) => [s.name ? `${s.name}:` : "", ...s.items].filter(Boolean).join("\n")).join("\n\n");
}

export function textToList(text, title) {
  const sections = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s+/, "");
    if (!line) continue;
    if (line.endsWith(":")) { current = { name: line.slice(0, -1).trim(), items: [] }; sections.push(current); continue; }
    if (!current) { current = { name: "", items: [] }; sections.push(current); }
    current.items.push(line);
  }
  return { title, sections };
}
