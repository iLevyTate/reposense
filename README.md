<div align="center">

# RepoSense

**Visualize your repo cinematically.**

Every file becomes a tower. Every folder becomes a terrace. A repository
assembles itself into a structure you can fly through — sized by bytes,
coloured by language, lit by how recently it changed.

[**Open the visualizer →**](https://ilevytate.github.io/reposense/)

<img src="public/cover.png" alt="RepoSense rendering its own repository: concentric glowing terraces stepping outward and upward, with file towers standing on each one" width="100%">

<sub>RepoSense visualizing itself — the outer arm is the vendored copy of three.js.</sub>

</div>

---

## Two ways in

### 1. The hosted site — paste a repo name

Go to **[ilevytate.github.io/reposense](https://ilevytate.github.io/reposense/)**,
type `owner/repository`, and watch it build. Nothing to install; the page talks
to the GitHub API directly from your browser.

Any of these work in the box:

```
sindresorhus/got
https://github.com/pallets/flask
git@github.com:charmbracelet/bubbletea.git
```

Every view is linkable — `…/reposense/#/pallets/flask` loads that repo directly.

> **Rate limits.** Anonymous GitHub API access allows 60 requests/hour per IP,
> and a repository costs about five, so you get roughly a dozen repos per hour.
> Paste a [personal access token](https://github.com/settings/tokens) under
> **Options** to raise that to 5,000/hour and to open private repositories. The
> token is kept in your browser's local storage and is sent only to
> `api.github.com` — there is no RepoSense server to send it to.

### 2. The local CLI — your own repo, full history

```bash
npx github:iLevyTate/reposense
```

Run it inside any git repository. It scans the working tree, replays the commit
log, writes `reposense.json`, and opens the viewer pointed at it.

This path exists because it is strictly better where it applies:

|                        | Hosted site                    | Local CLI                |
| ---------------------- | ------------------------------ | ------------------------ |
| Private repositories   | needs a token                  | works, no token          |
| Rate limits            | 60/hr anonymous                | none                     |
| Commit history         | recent slice, via deep scan    | the entire log           |
| Per-file authorship    | deep scan only                 | always                   |
| Growth timeline        | deep scan only                 | always                   |

```bash
reposense                      # scan . and open the viewer
reposense ~/code/api --json    # just write the JSON, no browser
reposense --no-history         # skip the git log pass (fast on huge repos)
reposense -c 500               # only the newest 500 commits
reposense --port 8080          # viewer on a different port
```

Node 18+, no dependencies, nothing leaves your machine.

The `reposense.json` it writes can be **dropped straight onto the hosted site** —
drag it anywhere on the start screen. That is the export path for private code:
the visualization runs in your browser, and the data never goes anywhere.

---

## Reading the structure

The layout is a **radial icicle**: depth in the tree maps to a concentric ring
*and* to altitude, so the repository reads as a stepped ziggurat rather than a
flat sunburst.

| You see        | It means                                                       |
| -------------- | -------------------------------------------------------------- |
| **Ring**       | how deep a file sits in the tree                                 |
| **Terrace**    | a directory — everything it contains stands on it                |
| **Tower**      | a file; height is its size on a log scale                        |
| **Colour**     | language                                                         |
| **Glow**       | churn — lines added and deleted, when history is available       |
| **Bridge**     | the ramp from a folder's slice up to its own terrace             |
| **Core**       | the repository root, at the centre of everything                 |

Sector width is proportional to weight, so a directory's slice of the disc is
its share of the codebase. Sibling order is deterministic — the same repository
always produces the same structure.

### Three views

- **Arcology** — the structure itself. Hover any tower to inspect it, click to
  open it on GitHub, search to isolate a subtree.
- **Chronology** — scrub the repository's history. With creation dates
  available, towers rise as history reaches them; otherwise the timeline drives
  churn heat only, and the panel says so rather than pretending.
- **Constellation** — contributors in orbit, sized by commits, with light-arcs
  to the directories they actually touched.

Press **T** for a scripted camera tour through all three, and **R** to record it
to a WebM file.

### Keyboard

| Key | |
| --- | --- |
| `1` `2` `3` | switch view |
| `T` | play the tour |
| `R` | record video |
| `P` | save a PNG |
| `F` | search |
| `Space` | play/pause the timeline |
| `0` | reset the view |
| `Esc` | clear selection · stop the tour |

---

## Honesty about the data

A visualization that quietly invents data is worse than no visualization. So:

- **Sizes and structure** are always real — from the git tree.
- **Churn, authorship and creation dates** require history. The hosted site has
  none by default, because the commit-list API does not return file lists; the
  optional **deep scan** opens recent commits one request each to recover them.
  The local CLI always has all of it.
- When history is missing, Chronology is **disabled** and the composition panel
  explains why, rather than animating something meaningless.
- On very large repositories the smallest files are folded into `…N more files`
  towers to protect the frame rate. The counts in the HUD still describe every
  file, and the panel tells you how many were folded.
- If GitHub truncates the tree for an enormous repository, the panel says so.

---

## How it works

No backend, no build step. The site is static files served by GitHub Pages; the
browser calls the GitHub API directly.

```
index.html            shell, import map
src/
  main.js             routing, loading, interaction
  github.js           GitHub REST client, deep scan, token handling
  model.js            flat file list  ->  weighted hierarchy
  layout.js           radial icicle layout + camera framing
  palette.js          language detection and colours
  scene/
    stage.js          renderer, camera rig, bloom pipeline, starfield
    arcology.js       terraces, instanced towers, bridges, picking
    constellation.js  contributor orbits and attribution arcs
    cinema.js         scripted camera tour, WebM recorder
  ui/hud.js           panels, inspector, tooltip, toasts
scripts/reposense.mjs the local scanner (zero dependencies)
vendor/three/         three.js, vendored so there is no CDN dependency
```

Some implementation notes worth knowing if you dig in:

- **All towers are one `InstancedMesh`.** Colour, churn, search state and
  timeline presence are per-instance attributes, so 14,000 files cost one draw
  call and a scrub costs one buffer upload.
- **Tower altitude lives in the instance matrix, not the shader.** The terraces
  offset altitude in their vertex shader for a free reveal animation, but the
  raycaster reads matrices — towers that floated in the shader would be picked
  at the wrong height.
- **Every material is a custom unlit shader**, authored deliberately bright so
  the bloom threshold turns crowns and rim strips into light sources. The scene
  therefore contains no lights and no fog at all.
- **Camera framing follows the weighted centroid**, not the origin. A radial
  layout is only centred when the tree is balanced, and real repositories have
  one vendored dependency stretching a thin arm into the distance.

### Running it locally

```bash
git clone https://github.com/iLevyTate/reposense
cd reposense
npm start          # http://localhost:4173
```

`.github/workflows/pages.yml` deploys `main` to GitHub Pages. To host your own
copy: fork it, then **Settings → Pages → Source: GitHub Actions**. There is no
build step — the workflow syntax-checks the sources, regenerates the bundled
example from the repo's own git log, and uploads the tree as-is.

A few details that keep the deployed page the *whole* product rather than a
static shell of it:

- **`.nojekyll`** at the root stops GitHub from running the tree through Jekyll,
  which would otherwise mangle `vendor/` and drop paths it considers private.
- **Every path is relative** (`./src/…`, `./vendor/…`), including the import
  map, so the app works unchanged at `/reposense/`, at a user site, or behind a
  custom domain.
- **Routing lives in the location hash**, so deep links, the browser Back
  button, and refreshes all work with no server rewrite rules.
- **`404.html`** bounces stray paths back into the app, and turns
  `…/reposense/owner/repo` into `…/reposense/#/owner/repo`.

## License

MIT — see [LICENSE](LICENSE).
