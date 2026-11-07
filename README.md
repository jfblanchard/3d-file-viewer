# 3d-file-viewer

General-purpose 3D files in the browser. No build step, no server, no
uploads — static files only, everything stays client-side.

## Formats

- **STEP / IGES / BRep** — parsed client-side by
  [occt-import-js](https://github.com/kovacsv/occt-import-js) (the real
  OpenCascade kernel compiled to WebAssembly). Assembly bodies come
  through with their names.
- **STL / OBJ / PLY / 3MF / glTF / GLB** — three.js loaders.

## Features

- Orbit / zoom / pan, wireframe, edge overlay, grid toggle
- **Model tree** — docked left sidebar, per-part visibility with color
  swatches (STEP part colors come through)
- **Orientation gizmo** — XYZ triad in the lower-right, tracks the camera
- **Measure** — click two points, get a distance readout
- **Section** — Z clipping-plane slider
- **Convert / export** — any loaded model downloads as GLB, STL, OBJ,
  or PLY (drop a STEP, get a glTF)
- **Dims** — bounding-box dimensions in the corner
- **Screenshot** — PNG button
- **Shareable link** — `Copy link` gzips the file and embeds it in the
  URL fragment (`#name.stl;gz=…`). Nothing is uploaded anywhere; the URL
  itself carries the model. Files over ~450 KB get a `?url=` link to a
  hosted copy instead.
- Up-axis toggle — Y-up by default (3D/optics convention), Z-up for CAD.

## Run it

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Any static server works. (`file://` works too except the module imports —
serve over HTTP for reliability.)

## Deploy to Cloudflare Pages

The whole folder is the site. Drag it onto a Pages project or point Pages
at a git repo — build command: none, output directory: `/`.

## How it works

`viewer.js` is one ES module. Three.js renders; `OrbitControls` handles
the camera. For B-rep formats the file bytes go to
`occt.ReadStepFile()` / `ReadIgesFile` / `ReadBrepFile`, which return
triangulated meshes with part names → `BufferGeometry` per part.
fflate (gzip) powers the share link.

## Roadmap

- [ ] Measurement on edges/faces, not just surface points
- [ ] Explode view for assemblies
- [ ] OBJ MTL / glTF material passthrough
