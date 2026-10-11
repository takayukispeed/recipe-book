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

// In-memory fake of the repo, seeded from recipes/ and meals/.
const repo = {};
for (const dir of ["recipes", "meals"]) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".md"))) {
    repo[`${dir}/${f}`] = fs.readFileSync(path.join(ROOT, dir, f), "utf8");
  }
}
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

  // Meal linking a recipe
  await page.goto(base + "#/new/meal");
  await page.fill("#title", "Sunday Ragù");
  await page.selectOption("#add-recipe", "recipes/marcella-hazan-bolognese.md");
  await page.fill("#components", (await page.inputValue("#components")) + "\nGreen salad");
  await page.click("#save");
  await page.waitForSelector(".components a");
  await shot("6-meal");
  await page.click(".components a");
  await page.waitForSelector("h1:has-text('Bolognese')");

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
    "Add meal: Sunday Ragù", "Delete recipe: Weeknight Tacos",
  ]);
  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log("e2e passed");
})().catch((e) => { console.error(e); process.exit(1); });
