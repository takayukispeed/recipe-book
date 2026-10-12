// Parse and serialize the Markdown files in places/<city>/, plus opening-hours logic.
// Shared by the app (browser) and tests (Node).
import { parseFrontMatter, listItems, slugify } from "./format.js";

// [key, label, colour]. Order here is the order categories are listed in.
export const CATEGORIES = [
  ["cheap", "Cheap eats", "#4f7a34"],
  ["nice", "Nice meal", "#b5452b"],
  ["cafe", "Cafés", "#8a5a2b"],
  ["bakery", "Bakeries", "#c0841a"],
  ["beer", "Beer bars", "#2f6f8f"],
  ["cocktail", "Fancy bars", "#7b3f91"],
];
const CAT = Object.fromEntries(CATEGORIES.map(([k, label, colour]) => [k, { label, colour }]));
export const categoryLabel = (k) => CAT[k]?.label || k || "Other";
export const categoryColour = (k) => CAT[k]?.colour || "#7a7065";
export const categoryOrder = (k) => { const i = CATEGORIES.findIndex(([c]) => c === k); return i < 0 ? 99 : i; };

const str = (v) => (typeof v === "string" ? v : "");

export function parsePlace(text) {
  const { meta, body } = parseFrontMatter(text);
  const sections = {};
  let current = null;
  for (const line of body.split("\n")) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) { current = h2[1].trim().toLowerCase(); sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  const title = body.match(/^#\s+(.*)$/m)?.[1].trim();
  const num = (v) => (str(v) && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    name: str(meta.name) || title || "Untitled",
    city: str(meta.city),
    category: str(meta.category),
    area: str(meta.area),
    address: str(meta.address),
    phone: str(meta.phone),
    website: str(meta.website),
    lat: num(meta.lat),
    lng: num(meta.lng),
    checked: str(meta.checked),
    hours: listItems((sections.hours || []).join("\n")),
    notes: (sections.notes || []).join("\n").trim(),
  };
}

const fm = (key, value) => `${key}: ${value ?? ""}`.trimEnd();

export function serializePlace(p) {
  const out = [
    "---",
    fm("name", p.name),
    fm("city", p.city),
    fm("category", p.category),
    fm("area", p.area),
    fm("address", p.address),
    fm("phone", p.phone),
    fm("website", p.website),
    fm("lat", p.lat ?? ""),
    fm("lng", p.lng ?? ""),
    fm("checked", p.checked),
    "---", "", `# ${p.name}`, "", "## Hours", "",
  ];
  for (const h of p.hours || []) out.push(`- ${h}`);
  out.push("", "## Notes", "");
  if (p.notes?.trim()) out.push(p.notes.trim(), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export const placePath = (p) => `places/${slugify(p.city || "other")}`;

// ---- Hours ----------------------------------------------------------------
// One line per day or day range, e.g.
//   Mon–Fri: 11:30–14:00, 17:00–22:00
//   Sat, Sun: 10:00–03:00     (a closing time earlier than the opening runs past midnight)
//   Tue: Closed
//   Daily: 8:00–15:00
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_RE = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i;
const dayIndex = (s) => { const m = s.trim().match(DAY_RE); return m ? DAYS.findIndex((d) => d.toLowerCase() === m[1].toLowerCase()) : -1; };

function parseTime(s) {
  const m = s.trim().match(/^(\d{1,2})(?:[:h](\d{2})?)?$/i);
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2] || 0);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

function parseDays(s) {
  s = s.trim();
  if (/^(daily|every ?day|all week)$/i.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  const days = [];
  for (const part of s.split(",")) {
    const [a, b] = part.split(/\s*[–—-]\s*/);
    const i = dayIndex(a);
    if (i < 0) return null;
    if (b === undefined) { days.push(i); continue; }
    const j = dayIndex(b);
    if (j < 0) return null;
    for (let d = i; ; d = (d + 1) % 7) { days.push(d); if (d === j) break; }
  }
  return days;
}

// → array of 7 (Mon..Sun), each null (unknown) or a list of [open, close] minutes; [] = closed.
export function parseHours(lines) {
  const week = Array(7).fill(null);
  let any = false;
  for (const line of lines || []) {
    const m = line.match(/^([^:]+?)\s*:\s*(.+)$/);
    if (!m) continue;
    const days = parseDays(m[1]);
    if (!days) continue;
    let ranges = [];
    if (!/^closed$/i.test(m[2].trim())) {
      for (const r of m[2].split(",")) {
        const [a, b] = r.split(/\s*[–—-]\s*/);
        const open = parseTime(a || ""); let close = parseTime(b || "");
        if (open === null || close === null) { ranges = null; break; }
        if (close <= open) close += 24 * 60; // past midnight
        ranges.push([open, close]);
      }
    }
    if (!ranges) continue;
    for (const d of days) week[d] = ranges;
    any = true;
  }
  return any ? week : null;
}

const fmt = (min) => { const m = min % (24 * 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
export const weekday = (date) => (date.getDay() + 6) % 7; // Mon = 0

// → null when hours are unknown, else { open, text } describing now.
export function hoursStatus(lines, now = new Date()) {
  const week = parseHours(lines);
  if (!week) return null;
  const d = weekday(now);
  const t = now.getHours() * 60 + now.getMinutes();
  const yesterday = week[(d + 6) % 7] || [];
  for (const [o, c] of yesterday) if (c > 24 * 60 && t < c - 24 * 60) return { open: true, text: `Open until ${fmt(c)}` };
  const today = week[d];
  if (today === null) return null;
  for (const [o, c] of today) if (t >= o && t < c) return { open: true, text: `Open until ${fmt(c)}` };
  const later = today.find(([o]) => o > t);
  if (later) return { open: false, text: `Closed · opens ${fmt(later[0])}` };
  for (let i = 1; i <= 7; i++) {
    const next = week[(d + i) % 7];
    if (next?.length) return { open: false, text: `Closed · opens ${i === 1 ? "tomorrow" : DAYS[(d + i) % 7]} ${fmt(next[0][0])}` };
  }
  return { open: false, text: "Closed" };
}

// Which hours line mentions today, so the view can highlight it.
export function todayLine(lines, now = new Date()) {
  const d = weekday(now);
  return (lines || []).findIndex((line) => {
    const m = line.match(/^([^:]+?)\s*:/);
    return m && (parseDays(m[1]) || []).includes(d);
  });
}

// OpenStreetMap "opening_hours" (simple forms only) → our lines. [] if it can't be converted.
export function osmHoursToLines(osm) {
  const map = { Mo: "Mon", Tu: "Tue", We: "Wed", Th: "Thu", Fr: "Fri", Sa: "Sat", Su: "Sun" };
  const out = [];
  for (const part of (osm || "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)\s+(off|closed|\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:,\d{1,2}:\d{2}-\d{1,2}:\d{2})*)$/);
    if (!m) return [];
    const days = m[1].replace(/Mo|Tu|We|Th|Fr|Sa|Su/g, (d) => map[d]).replace(/-/g, "–").replace(/,/g, ", ");
    const times = /off|closed/.test(m[2]) ? "Closed" : m[2].replace(/-/g, "–").replace(/,/g, ", ");
    out.push(`${days}: ${times}`);
  }
  return out;
}
