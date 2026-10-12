# Recipe Book

All my recipes, grocery staples and favourite restaurants and bars in one place. They are stored as plain Markdown files in this repo and used through an iPhone app.

- **App:** https://takayukispeed.github.io/recipe-book/ (see [Setting up the iPhone app](#setting-up-the-iphone-app))
- **Browse on GitHub:** [INDEX.md](INDEX.md)

## Layout

```
recipes/     one file per recipe
places/      one folder per city, one file per restaurant, café or bar
lists/       staples.md: things you buy often, grouped by store section
templates/   copy one of these to start something new by hand
index.html   the app (plus app/, sw.js, manifest.webmanifest)
scripts/     build_index.py regenerates INDEX.md; geocode_places.py adds map pins (both run on GitHub)
tests/       format round-trip test and an iPhone end-to-end test
```

## Two kinds of recipe

| `type:` | Use for | Sections |
|---|---|---|
| `quick` | Things you already know how to make and only need a shopping/prep list for | Ingredients, Notes |
| `full` | Technique-dependent recipes where the steps matter (e.g. Hazan's bolognese) | Ingredients, Method, Notes |

Write amounts as imperial first with metric in brackets, e.g. `1 cup (240 mL) whole milk`, `2½ lb (1.1 kg) beef chuck`.

## Setting up the iPhone app

The app is a home-screen web app. It is free, needs no App Store, and works offline once it has loaded.

**One-time setup on GitHub** (on a computer, or in Safari on the phone):

1. Open the repo's **Settings → Pages**.
2. Under *Build and deployment*, set **Source: GitHub Actions**.
3. The `Deploy app` workflow (`.github/workflows/pages.yml`) publishes the app on every push to `main`. It also appears in the Actions tab with a pass or fail.
4. The app is live at https://takayukispeed.github.io/recipe-book/.

**On the iPhone:**

1. Open that link in **Safari**. Other browsers can't install home-screen apps on older iOS versions.
2. Tap **Share → Add to Home Screen**. It now opens full-screen from its own icon.
3. To add or edit recipes, open the app's ⚙︎ **Settings** and paste a GitHub token. The settings screen explains how to make one: a *fine-grained* token limited to this one repo, with **Contents: Read and write**.

The home-screen app has its own storage, separate from Safari, so add the token *inside the installed app*.

### How sync works

- Recipes are read from this repo through the GitHub API and cached on the phone, so they keep working offline.
- Saving in the app commits the Markdown file straight to `main`. It shows up in the repo history as "Add recipe: …" or "Update recipe: …".
- A GitHub Action then rebuilds `INDEX.md`.
- Edits made on GitHub, or made by Claude, appear in the app the next time it opens or you tap ↻.
- Reading without a token is limited by GitHub to 60 requests an hour. That is plenty, because only changed files are re-downloaded.

**Token safety:** the token is stored only on the phone, in the app's storage. Limit it to this repo with Contents permission only, so that if it leaks it can't touch anything else. Revoke it at https://github.com/settings/personal-access-tokens at any time.

## In the app

- **Search** matches titles, tags *and* ingredients, e.g. "pancetta". Tap a tag chip to filter.
- **Ingredients:** tap to tick them off as you prep. **Reset** clears them.
- **Scale:** ½× to 3× buttons above the ingredients multiply every amount (imperial and metric) and the servings. Scaled numbers are highlighted. Amounts written inside method steps aren't scaled.
- **Method:** tap a step to highlight where you are.
- **Keep screen on while cooking:** a toggle at the bottom of each recipe.
- **Staples:** your regular grocery buys, grouped by store section. Tap items to tick them off in the store; ticks stay on the phone until you **Clear ticks**. Add items with the bar at the top, or rename, remove and reorder them with **Edit list**.

## Places

The **Places** tab is a list of restaurants, cafés and bars to take people to, by city.

| `category:` | Shown as |
|---|---|
| `cheap` | Cheap eats |
| `nice` | Nice meal |
| `cafe` | Cafés |
| `bakery` | Bakeries |
| `beer` | Beer bars |
| `cocktail` | Fancy bars |

- **City** picker at the top (once there's more than one city), then category chips, search, and **Open now**.
- **List / Map** switch. The map uses OpenStreetMap and needs a connection; the list works offline.
- Each place has **Directions** (Apple Maps on iPhone) and **Google Maps**, which has photos, reviews and up-to-date hours.
- **Hours** are written one line per day or range, e.g. `Mon–Fri: 11:30–14:00, 17:00–22:00`, `Sat: 17:00–02:00` (past midnight is fine), `Sun: Closed`, or `Daily: 8:00–15:00`. Today's line is highlighted and the list shows *Open until …* / *Closed · opens …*. Hours drift, so `checked:` records the month they were last checked.
- **Adding one:** tap +, type the name and city, then **Look up on OpenStreetMap**. It fills in the map location, plus the address, phone, website and hours when OpenStreetMap has them. Check what it found before saving.
- **Map pins:** when a place is saved without `lat`/`lng`, a GitHub Action looks the address up and commits the coordinates. Until then the app looks it up on the phone. Use full street names (`Boulevard Saint-Laurent`, `Rue Rachel Est`) so the lookup finds them.
- Why not pull data from Google automatically? Google's Places API needs a paid, billed API key, and a key stored in this public app could be used by anyone. OpenStreetMap is free and needs no key. The Google Maps button covers the rest.

By hand: copy `templates/place.md` to `places/<city>/<short-name>.md`.

## Adding a recipe by hand

1. Copy `templates/quick.md` or `templates/full.md` to `recipes/<short-name>.md`. Use lowercase with hyphens.
2. Fill in the front matter (`title`, `tags`, `serves`, `source`) and the body.
3. Push. The index rebuilds itself. Locally you can run `python3 scripts/build_index.py`.

Tags are free-form. Some suggestions: `weeknight`, `project`, `freezer`, `pasta`, `vegetarian`, `breakfast`, `baking`.

## Sources and copying

Ingredient lists are facts, but a published method's wording is the author's. Write methods in your own words and always fill in `source:`.

## Tests

```
node tests/format.test.mjs                               # every recipe survives the app's parse → save round trip
NODE_PATH=$(npm root -g) node tests/app.e2e.cjs [shots]  # full flow in an emulated iPhone (needs Playwright)
NODE_PATH=$(npm root -g) node tests/update.e2e.cjs         # installed app picks up a new deploy
```
