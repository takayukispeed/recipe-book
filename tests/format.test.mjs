// Run: node tests/format.test.mjs
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { parseRecipe, serializeRecipe, parseMeal, serializeMeal, inline, slugify } from "../app/format.js";

// Every recipe in the repo must survive a parse → serialize round trip unchanged.
for (const f of readdirSync("recipes").filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(`recipes/${f}`, "utf8");
  assert.equal(serializeRecipe(parseRecipe(text)), text, `round trip: ${f}`);
}
for (const f of readdirSync("meals").filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(`meals/${f}`, "utf8");
  assert.equal(serializeMeal(parseMeal(text)), text, `round trip: ${f}`);
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

const meal = { title: "Sunday", tags: [], components: ["Main: [Bolognese](../recipes/marcella-hazan-bolognese.md)", "Green salad"], notes: "" };
assert.deepEqual(parseMeal(serializeMeal(meal)).components, meal.components);

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
