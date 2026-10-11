# Recipe Book

All my recipes and meals in one place. They are plain Markdown files, so they read well on GitHub or a phone and need no app.

**→ Browse: [INDEX.md](INDEX.md)**

## Layout

```
recipes/     one file per recipe
meals/       combinations of recipes (e.g. "Sunday ragù dinner")
templates/   copy one of these to start something new
scripts/     build_index.py regenerates INDEX.md
```

## Two kinds of recipe

| `type:` | Use for | Sections |
|---|---|---|
| `quick` | Things you already know how to make and only need a shopping/prep list for | Ingredients, Notes |
| `full` | Technique-dependent recipes where the steps matter (e.g. Hazan's bolognese) | Ingredients, Method, Notes |

## Adding a recipe

1. Copy `templates/quick.md` or `templates/full.md` to `recipes/<short-name>.md`. Use lowercase with hyphens.
2. Fill in the front matter (`title`, `tags`, `serves`, `source`) and the body.
3. Run `python3 scripts/build_index.py` to update the index.

Write amounts as imperial first with metric in brackets, e.g. `1 cup (240 mL) whole milk`, `2½ lb (1.1 kg) beef chuck`.

Tags are free-form. Some suggestions: `weeknight`, `project`, `freezer`, `pasta`, `vegetarian`, `breakfast`, `baking`.

## Sources and copying

Ingredient lists are facts, but a published method's wording is the author's. Write methods in your own words and always fill in `source:`.
