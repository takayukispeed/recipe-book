// End-to-end smoke test in an emulated iPhone, with the GitHub API mocked
// from the files in this repo. Needs Playwright:
//   NODE_PATH=$(npm root -g) node tests/app.e2e.cjs [screenshot-dir]
const { chromium, devices } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = process.argv[2];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".md": "text/markdown" };

// Static server for the app.
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

// In-memory fake of the repo, seeded from recipes/ and lists/.
const repo = {};
for (const dir of ["recipes", "lists"]) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".md"))) {
    repo[`${dir}/${f}`] = fs.readFileSync(path.join(ROOT, dir, f), "utf8");
  }
}
for (const city of fs.readdirSync(path.join(ROOT, "places"))) {
  for (const f of fs.readdirSync(path.join(ROOT, "places", city)).filter((f) => f.endsWith(".md"))) {
    repo[`places/${city}/${f}`] = fs.readFileSync(path.join(ROOT, "places", city, f), "utf8");
  }
}
// Fixed staples list so the test doesn't depend on the real one.
repo["lists/staples.md"] = `---
title: Staples
---

# Staples

## Drinks

- Montellier sparkling water

## Frozen

- Pizza Pops

## Pantry

- Hamburger Helper
- Annie's Mac & Cheese
`;
const sha = (t) => crypto.createHash("sha1").update(t).digest("hex");
const commits = [];

async function mockGitHub(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname.replace("/repos/takayukispeed/recipe-book", "");
  const cors = { "Access-Control-Allow-Origin": "*" };
  const json = (status, body) => route.fulfill({ status, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (p.startsWith("/git/trees/")) {
    return json(200, { tree: Object.entries(repo).map(([path, t]) => ({ path, type: "blob", sha: sha(t) })) });
  }
  if (p.startsWith("/git/blobs/")) {
    const hit = Object.values(repo).find((t) => sha(t) === p.split("/").pop());
    return route.fulfill({ status: hit ? 200 : 404, headers: cors, body: hit || "" });
  }
  if (p.startsWith("/contents/")) {
    const file = decodeURIComponent(p.slice("/contents/".length));
    const body = JSON.parse(req.postData());
    if (repo[file] && body.sha !== sha(repo[file])) return json(409, { message: "sha mismatch" });
    commits.push({ method: req.method(), file, message: body.message });
    if (req.method() === "DELETE") { delete repo[file]; return json(200, {}); }
    repo[file] = Buffer.from(body.content, "base64").toString("utf8");
    return json(200, { content: { sha: sha(repo[file]) } });
  }
  if (p === "") return json(200, { permissions: { push: true } });
  return json(404, { message: "not mocked" });
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 15"], serviceWorkers: "block" });
  await ctx.route("https://api.github.com/**", mockGitHub);
  await ctx.route("https://unpkg.com/**", (r) => r.abort()); // no Leaflet offline: the map shows a message
  await ctx.route("https://nominatim.openstreetmap.org/**", (r) => r.fulfill({
    status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    body: JSON.stringify([{ lat: "45.5236", lon: "-73.5825", display_name: "Kazu, 1862, Rue Sainte-Catherine Ouest, Montréal",
      address: { house_number: "1862", road: "Rue Sainte-Catherine Ouest", city: "Montréal", postcode: "H3H 1M1", suburb: "Ville-Marie" },
      extratags: { opening_hours: "Mo,Th-Su 12:00-21:00; Tu,We off", phone: "+1 514-937-2333" } }]),
  }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

  // List
  await page.goto(base);
  await page.waitForSelector(".card");
  assert.equal(await page.locator(".card").count(), Object.keys(repo).filter((p) => p.startsWith("recipes/")).length);
  await shot("1-list");

  // Search keeps focus while typing and filters by ingredient
  await page.fill("#search", "pancetta");
  assert.equal(await page.evaluate(() => document.activeElement.id), "search");
  assert.equal(await page.locator(".card").count(), 1);
  await page.fill("#search", "");

  // Recipe view: tick an ingredient, highlight a step
  await page.click("text=Ragù alla Bolognese");
  await page.waitForSelector(".steps");
  await page.locator(".ing").first().click();
  assert.equal(await page.locator(".ing.done").count(), 1);
  await page.locator(".step").nth(2).click();
  assert.equal(await page.locator(".step.current").count(), 1);
  await shot("2-recipe");

  // Scaling: 2× doubles amounts and servings, 1× restores the original text
  await page.click(".scale button:has-text('2×')");
  assert.match(await page.locator(".ing").nth(1).innerText(), /^6 Tbsp \(90 g\) butter, plus 2 Tbsp \(30 g\)/);
  assert.match(await page.locator(".meta").innerText(), /Serves 12/);
  assert.ok(await page.locator(".scale-note").isVisible());
  assert.equal(await page.locator(".ing.done").count(), 1, "ticks survive scaling");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("2b-recipe-scaled");
  await page.click(".scale button:has-text('1×')");
  assert.match(await page.locator(".ing").nth(1).innerText(), /^3 Tbsp \(45 g\) butter/);
  await page.evaluate(() => window.scrollTo(0, 900));
  await shot("3-recipe-method");

  // Editing without a token is blocked
  await page.click("text=Edit");
  assert.ok(await page.locator("#save").isDisabled());

  // Add a token, then create a quick recipe
  await page.goto(base + "#/settings");
  await page.fill("#token", "github_pat_test");
  await page.click("#save-token");
  await page.waitForSelector("text=Connected");
  await shot("4-settings");

  await page.goto(base + "#/new/recipe");
  await page.fill("#title", "Weeknight Tacos");
  await page.fill("#tags", "Weeknight, mexican");
  await page.fill("#serves", "4");
  await page.fill("#ingredients", "8 corn tortillas\n1 lb (450 g) ground beef\n\n1 lime");
  await shot("5-editor");
  await page.click("#save");
  await page.waitForURL(/#\/view\/recipes\/weeknight-tacos\.md$/);
  assert.equal(repo["recipes/weeknight-tacos.md"], `---
title: Weeknight Tacos
type: quick
tags: [weeknight, mexican]
serves: 4
source:
---

# Weeknight Tacos

## Ingredients

- 8 corn tortillas
- 1 lb (450 g) ground beef
- 1 lime

## Notes
`);

  // Edit it: switch to full method
  await page.click("text=Edit");
  await page.click("[data-type=full]");
  await page.fill("#method", "Brown the beef.\nWarm the tortillas.");
  await page.click("#save");
  await page.waitForSelector(".steps");
  assert.match(repo["recipes/weeknight-tacos.md"], /type: full[\s\S]*## Method\n\n1\. Brown the beef\.\n2\. Warm the tortillas\./);

  // Old meal links no longer exist
  await page.goto(base + "#/meals");
  await page.waitForSelector("text=That page isn't here");
  await page.goto(base + "#/");
  await page.waitForSelector(".card");
  assert.deepEqual(await page.locator(".segmented a").allInnerTexts(), ["Recipes", "Staples", "Places"]);

  // Staples: view, tick (persists across reload), quick-add, new section, edit
  await page.goto(base + "#/staples");
  await page.waitForSelector(".staples .ing");
  assert.equal(await page.locator(".staples .ing").count(), 4);
  assert.deepEqual(await page.locator(".list-heading").allInnerTexts(), ["DRINKS", "FROZEN", "PANTRY"].map((s) => s), "sections in order");
  await page.click("text=Pizza Pops");
  await page.reload();
  await page.waitForSelector(".staples .ing.done");
  assert.equal(await page.locator(".staples .ing.done").innerText(), "Pizza Pops");
  await page.selectOption("#staple-section", "Frozen");
  await page.fill("#staple-add", "Frozen berries");
  await page.click(".add-btn");
  await page.waitForSelector("text=Frozen berries");
  assert.match(repo["lists/staples.md"], /## Frozen\n\n- Pizza Pops\n- Frozen berries\n/);
  page.once("dialog", (d) => d.accept("Household"));
  await page.selectOption("#staple-section", "__new");
  await page.fill("#staple-add", "Paper towels");
  await page.click(".add-btn");
  await page.waitForSelector("text=Paper towels");
  assert.match(repo["lists/staples.md"], /## Household\n\n- Paper towels\n$/);
  await page.fill("#search", "mac");
  assert.equal(await page.locator(".staples .ing").count(), 1);
  await page.fill("#search", "");
  await shot("7-staples");
  await page.click("text=Edit list");
  assert.match(await page.inputValue("#list-text"), /^Drinks:\nMontellier sparkling water\n\nFrozen:/);
  await shot("8-staples-edit");
  await page.fill("#list-text", (await page.inputValue("#list-text")).replace("Paper towels\n", "").replace("Paper towels", ""));
  await page.click("#save");
  await page.waitForURL(/#\/staples$/);
  assert.ok(!repo["lists/staples.md"].includes("Household"), "empty section dropped");
  await page.click("#clear-ticks");
  assert.equal(await page.locator(".staples .ing.done").count(), 0);

  // Places: list grouped by category, filter, view, map fallback, add one with an OSM lookup
  const placeCount = Object.keys(repo).filter((p) => p.startsWith("places/")).length;
  await page.goto(base + "#/places");
  await page.waitForSelector(".card");
  assert.equal(await page.locator(".card").count(), placeCount);
  assert.deepEqual(await page.locator(".list-heading").allInnerTexts(),
    ["CHEAP EATS", "NICE MEAL", "CAFÉS", "BAKERIES", "BEER BARS", "FANCY BARS"]);
  await shot("9-places");
  await page.click(".chip[data-cat=beer]");
  assert.equal(await page.locator(".card").count(), 6);
  await page.fill("#search", "rachel");
  assert.equal(await page.locator(".card").count(), 2, "Pit Caribou and Projet Pilote");
  await page.fill("#search", "");
  await page.click(".chip[data-cat='']");
  await page.click("text=Big in Japan");
  await page.waitForSelector(".hours");
  assert.equal(await page.locator(".hours li").count(), 3);
  assert.match(await page.locator(".actions").innerText(), /Directions[\s\S]*Google Maps/);
  await shot("10-place");
  await page.goto(base + "#/places");
  await page.click("[data-mode=map]");
  await page.waitForSelector("text=The map needs a connection");
  await page.click("[data-mode=list]");
  await page.click(".fab");
  await page.fill("#name", "Kazu");
  await page.selectOption("#category", "cheap");
  assert.equal(await page.inputValue("#city"), "Montréal", "defaults to the city being browsed");
  await page.click("#lookup");
  await page.waitForSelector("text=Filled in");
  assert.equal(await page.inputValue("#address"), "1862 Rue Sainte-Catherine Ouest, Montréal, H3H 1M1");
  assert.equal(await page.inputValue("#hours"), "Mon, Thu–Sun: 12:00–21:00\nTue, Wed: Closed");
  assert.equal(await page.inputValue("#lat"), "45.523600");
  await shot("11-place-editor");
  await page.click("#save");
  await page.waitForURL(/#\/view\/places\/montreal\/kazu\.md$/);
  assert.match(repo["places/montreal/kazu.md"], /^---\nname: Kazu\ncity: Montréal\ncategory: cheap\narea: Ville-Marie\n[\s\S]*lat: 45\.5236\nlng: -73\.5825\n[\s\S]*## Hours\n\n- Mon, Thu–Sun: 12:00–21:00\n- Tue, Wed: Closed\n/);
  page.once("dialog", (d) => d.accept());
  await page.goto(base + "#/edit/places/montreal/kazu.md");
  await page.click("#delete");
  await page.waitForURL(/#\/places$/);
  assert.ok(!repo["places/montreal/kazu.md"]);

  // Delete
  page.once("dialog", (d) => d.accept());
  await page.goto(base + "#/edit/recipes/weeknight-tacos.md");
  await page.click("#delete");
  await page.waitForURL(/#\/$/);
  assert.ok(!repo["recipes/weeknight-tacos.md"]);

  // Offline: a fresh load with the API down still shows cached recipes
  await ctx.unroute("https://api.github.com/**");
  await ctx.route("https://api.github.com/**", (r) => r.abort());
  await page.reload();
  await page.waitForSelector(".card");

  assert.deepEqual(commits.map((c) => c.message), [
    "Add recipe: Weeknight Tacos", "Update recipe: Weeknight Tacos",
    "Add staple: Frozen berries", "Add staple: Paper towels", "Update staples",
    "Add place: Kazu", "Delete place: Kazu",
    "Delete recipe: Weeknight Tacos",
  ]);
  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log("e2e passed");
})().catch((e) => { console.error(e); process.exit(1); });
