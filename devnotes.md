# Dev notes — 3d-file-viewer

Single-purpose static site. No build step, no backend. All parsing runs in the
browser; three.js and occt-import-js load from jsDelivr via the importmap in
`index.html`. Runs on Cloudflare Pages as-is — just point it at the repo.

## Architecture

- `index.html` — HUD toolbar, docked left `#sidebar` (model tree), `#info` line,
  `#drop` overlay, error trap that reports JS failures in the status bar.
- `viewer.js` — one ES module. Scenes: main `scene` + `gizmoScene` (orientation
  triad rendered into a scissored lower-right viewport each frame).
- Loaders: `occt-import-js` 0.0.22 (lazy-loaded) for STEP/IGES/BRep — returns
  tessellated meshes with names and colors. three.js loaders for
  STL/OBJ/PLY/3MF/glTF/GLB.
- `parts[]` drives the model tree; each entry `{ name, mesh, edges, color }`.
- Share link: file bytes → `gzipSync` → base64 → `#name;gz=…` fragment.
  Nothing is uploaded. `SHARE_MAX` = 450 KB; larger files need `?url=` pointing
  at a hosted copy.
- Export menu → GLB/STL/OBJ/PLY via three.js exporters (`meshesOnlyGroup()`
  rebuilds the model without edge overlays). STEP write is not available in the
  browser — occt-import-js is import-only.
- Up-axis selector: Z-up (CAD) vs Y-up (3D format convention). Purely a view
  transform — `camera.up` + grid plane — model coordinates are untouched.
- `BIG_FILE` = 100 MB soft warning; real limit is WASM/browser memory.

## State

- v2 working locally: `python3 -m http.server 8017` in this dir.
- Dev gotcha: files once got truncated to 0 bytes mid-edit (blank page); the
  inline error trap in index.html now surfaces JS failures visibly.
- Not yet pushed to GitHub — repo is local only.

## Next session TODO

- **Unit tests** (Jon's ask): verify export round-trips — load each format,
  export GLB/STL/OBJ/PLY, re-import and check geometry/vertex counts. Headless
  chromium + Puppeteer or Playwright is the practical route; there's no test
  rig yet.
- Test share-link round-trip and `?url=` path.
- GitHub remote + push, then Cloudflare Pages deploy.
- Optional: vendor three.js/occt locally to drop the CDN dependency.
- Optional feature ideas from Obsidian STEP-viewer: per-axis distance
  components, angle/radius measurement, annotations, nav cube.
