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
