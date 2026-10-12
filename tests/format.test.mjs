// Run: node tests/format.test.mjs
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { parseRecipe, serializeRecipe, inline, slugify } from "../app/format.js";

// Every recipe in the repo must survive a parse → serialize round trip unchanged.
for (const f of readdirSync("recipes").filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(`recipes/${f}`, "utf8");
  assert.equal(serializeRecipe(parseRecipe(text)), text, `round trip: ${f}`);
}

const r = parseRecipe(readFileSync("recipes/marcella-hazan-bolognese.md", "utf8"));
assert.equal(r.type, "full");
assert.deepEqual(r.tags, ["pasta", "beef", "italian", "project", "freezer"]);
assert.equal(r.method.length, 8);
assert.ok(r.ingredients[0].startsWith("1 Tbsp (15 mL)"));

const quick = { title: "Tacos", type: "quick", tags: ["weeknight"], serves: "4", source: "", ingredients: ["tortillas", "beef"], method: [], notes: "" };
const back = parseRecipe(serializeRecipe(quick));
assert.equal(back.type, "quick");
assert.deepEqual(back.ingredients, ["tortillas", "beef"]);
assert.ok(!serializeRecipe(quick).includes("## Method"));


assert.equal(inline("**a** <b>"), "<strong>a</strong> &lt;b&gt;");
assert.equal(inline("[x](../recipes/a-b.md)"), '<a href="#/view/recipes/a-b.md">x</a>');
assert.ok(!inline("[x](javascript:alert)").includes("href"));
assert.ok(inline("[gist](https://gist.github.com/a_b_c)").includes('href="https://gist.github.com/a_b_c"'));
assert.equal(slugify("Ragù alla Bolognese (Marcella Hazan)"), "ragu-alla-bolognese-marcella-hazan");
console.log("format tests passed");

// Scaling
import { scaleLine } from "../app/format.js";
const s = (line, f) => scaleLine(line, f);
assert.equal(s("1 cup (240 mL) whole milk", 2), "2 cups (480 mL) whole milk");
assert.equal(s("1½ cups (360 mL) canned tomatoes", 0.5), "¾ cup (180 mL) canned tomatoes");
assert.equal(s("2½ lb (1.1 kg) beef chuck, cut into ~2-inch (5 cm) chunks, seasoned with 2 tsp (10 mL) kosher salt", 2),
  "5 lb (2.2 kg) beef chuck, cut into ~2-inch (5 cm) chunks, seasoned with 4 tsp (20 mL) kosher salt");
assert.equal(s("1¼–1½ lb (570–680 g) pasta", 2), "2½–3 lb (1.1–1.4 kg) pasta");
assert.equal(s("1 bag (300–350 g / 10–12 oz) tortilla chips", 1.5), "1½ bags (450–530 g / 15–18 oz) tortilla chips");
assert.equal(s("1 can (540 mL / 19 oz) black beans, drained", 2), "2 cans (1.1 L / 38 oz) black beans, drained");
assert.equal(s("½ red onion, diced", 3), "1½ red onion, diced");
assert.equal(s("8 corn tortillas", 0.5), "4 corn tortillas");
assert.equal(s("4 sheets nori", 0.25), "1 sheet nori");
assert.equal(s("500 g (1.1 lb) salmon", 2), "1 kg (2.2 lb) salmon");
assert.equal(s("3 Tbsp (45 g) butter, plus 1 Tbsp (15 g) for tossing the pasta", 2), "6 Tbsp (90 g) butter, plus 2 Tbsp (30 g) for tossing the pasta");
assert.equal(s("Whole nutmeg (about ⅛ tsp / 0.5 mL grated)", 2), "Whole nutmeg (about ¼ tsp / 1 mL grated)");
assert.equal(s("Salt and pepper", 2), "Salt and pepper");
assert.equal(s("2 green onions, sliced", 2), "4 green onions, sliced");
assert.equal(s("1 lime", 3), "3 lime");
assert.equal(s("8–10 (sauce for ~2 lb pasta)", 2), "16–20 (sauce for ~4 lb pasta)");
assert.equal(s("1 cup (240 mL) whole milk", 1), "1 cup (240 mL) whole milk");
assert.equal(scaleLine("1 cup milk", 2, { mark: true }), "2 cups milk");
// Every real ingredient line scales without throwing and round-trips at 1×
for (const f of readdirSync("recipes").filter((f) => f.endsWith(".md"))) {
  const rec = parseRecipe(readFileSync(`recipes/${f}`, "utf8"));
  for (const line of rec.ingredients) { scaleLine(line, 2); assert.equal(scaleLine(line, 1), line); }
}
console.log("scaling tests passed");

// Lists
import { parseList, serializeList, listToText, textToList } from "../app/format.js";
for (const f of readdirSync("lists").filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(`lists/${f}`, "utf8");
  assert.equal(serializeList(parseList(text)), text, `round trip: lists/${f}`);
  const list = parseList(text);
  assert.deepEqual(textToList(listToText(list), list.title), list, `editor round trip: lists/${f}`);
}
const l = textToList("Drinks:\nSparkling water\n\nFrozen:\n- Pizza Pops\n", "Staples");
assert.deepEqual(l.sections, [{ name: "Drinks", items: ["Sparkling water"] }, { name: "Frozen", items: ["Pizza Pops"] }]);
assert.ok(!serializeList({ title: "S", sections: [{ name: "Empty", items: [] }] }).includes("Empty"));
console.log("list tests passed");

// Places
import { parsePlace, serializePlace, parseHours, hoursStatus, todayLine, osmHoursToLines } from "../app/places.js";
for (const city of readdirSync("places")) {
  for (const f of readdirSync(`places/${city}`).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(`places/${city}/${f}`, "utf8");
    const p = parsePlace(text);
    assert.equal(serializePlace(p), text, `round trip: places/${city}/${f}`);
    assert.ok(["cheap", "nice", "cafe", "bakery", "beer", "cocktail"].includes(p.category), `category: ${f}`);
    assert.ok(p.address, `address: ${f}`);
    if (p.hours.length) assert.ok(parseHours(p.hours), `hours parse: ${f}`);
  }
}
const bij = ["Mon: Closed", "Tue–Sat: 17:00–03:00", "Sun: Closed"];
const at = (s) => new Date(s); // 2026-10-12 is a Monday
assert.deepEqual(hoursStatus(bij, at("2026-10-12T20:00")), { open: false, text: "Closed · opens tomorrow 17:00" });
assert.deepEqual(hoursStatus(bij, at("2026-10-13T18:30")), { open: true, text: "Open until 3:00" });
assert.deepEqual(hoursStatus(bij, at("2026-10-14T02:00")), { open: true, text: "Open until 3:00" }, "past midnight");
assert.deepEqual(hoursStatus(bij, at("2026-10-18T02:30")), { open: true, text: "Open until 3:00" }, "Saturday night into Sunday");
assert.deepEqual(hoursStatus(bij, at("2026-10-18T12:00")), { open: false, text: "Closed · opens Tue 17:00" });
assert.deepEqual(hoursStatus(["Mon-Fri: 11:30-14:00, 17:00-22:00"], at("2026-10-12T15:00")), { open: false, text: "Closed · opens 17:00" });
assert.deepEqual(hoursStatus(["Daily: 8h–15h"], at("2026-10-12T09:00")), { open: true, text: "Open until 15:00" });
assert.equal(hoursStatus(["Mon: 9:00–17:00"], at("2026-10-13T10:00")), null, "today unknown");
assert.equal(hoursStatus([], at("2026-10-13T10:00")), null);
assert.equal(todayLine(bij, at("2026-10-14T12:00")), 1);
assert.deepEqual(osmHoursToLines("Mo-Fr 11:00-22:00; Sa,Su 10:00-23:00; Tu off"), ["Mon–Fri: 11:00–22:00", "Sat, Sun: 10:00–23:00", "Tue: Closed"]);
assert.deepEqual(osmHoursToLines("24/7"), []);
console.log("places tests passed");
