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
