// Checks the installed app picks up a new deploy even though GitHub Pages lets
// browsers cache files for 10 minutes. Needs Playwright:
//   NODE_PATH=$(npm root -g) node tests/update.e2e.cjs
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const assert = require("assert/strict");
const ROOT = path.resolve(__dirname, "..");
const overrides = {};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = new URL(req.url, "http://x").pathname; if (p.endsWith("/")) p += "index.html";
  const body = overrides[p] ?? (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p)) : null);
  if (body === null) { res.writeHead(404); return res.end(); }
  // Mimic GitHub Pages: cacheable for 10 minutes.
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream", "Cache-Control": "max-age=600" });
  res.end(body);
});
(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const b = await chromium.launch();
  const ctx = await b.newContext();
  await ctx.route("https://api.github.com/**", (r) => r.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: '{"tree":[]}' }));
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.reload();                       // now running under the SW
  await page.waitForSelector(".segmented");
  assert.deepEqual(await page.locator(".segmented a").allInnerTexts(), ["Recipes", "Staples", "Places"]);

  // Publish a "new version": changed app code + bumped SW.
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  overrides["/sw.js"] = sw.replace(/recipe-book-v\d+/, "recipe-book-vTEST");
  overrides["/app/app.js"] = fs.readFileSync(path.join(ROOT, "app/app.js"), "utf8")
    .replace('tab("#/staples", "staples", "Staples")', 'tab("#/staples", "staples", "Staples NEW")');

  // What happens when the app comes back to the foreground: update check → reload.
  const reloaded = page.waitForEvent("load");
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await reloaded;
  await page.waitForSelector(".segmented");
  assert.deepEqual(await page.locator(".segmented a").allInnerTexts(), ["Recipes", "Staples NEW", "Places"]);
  assert.deepEqual(errors, []);
  console.log("update flow passed: new version loaded despite max-age=600");
  await b.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
