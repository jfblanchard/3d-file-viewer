# 3d-file-viewer

General-purpose 3D files in the browser. No build step, no server, no
uploads; static files only, everything stays client-side.

It is two things at once: a viewer for poking through 3D files on disk
(point it at a folder and it thumbnails every model it finds), and a
format converter (drop a STEP file, download a glTF). Built for the
common case of "I have a directory of CAD exports and just want to see
what is in them."

## Formats

- **STEP / IGES / BRep**: parsed client-side by
  [occt-import-js](https://github.com/kovacsv/occt-import-js) (the real
  OpenCascade kernel compiled to WebAssembly). Assembly bodies come
  through with their names.
- **STL / OBJ / PLY / 3MF / glTF / GLB**: three.js loaders. Draco- and
  Meshopt-compressed GLBs decode too.

## Features

- Orbit / zoom / pan, wireframe, edge overlay, grid toggle
- **Model tree**: docked left sidebar, grouped into a collapsible tree
  by shared name prefixes, with per-part or per-group visibility and
  color swatches (STEP part colors come through)
- **Orientation gizmo**: XYZ triad in the lower-right, tracks the camera
- **Folder browsing**: `Open folder…` in the sidebar scans a local
  directory, lists every supported file inside with a rendered
  thumbnail, click to load (Chromium only; uses the File System
  Access API)
- **Samples**: the James Webb Space Telescope (default), the Voyager
  probe, and a toy car
- **Convert / export**: any loaded model downloads as GLB, STL, OBJ,
  or PLY (drop a STEP, get a glTF)
- **Dims**: bounding-box dimensions in the corner
- **Screenshot**: PNG button
- **Shareable link**: `Copy link` gzips the file and embeds it in the
  URL fragment (`#name.stl;gz=…`). Nothing is uploaded anywhere; the URL
  itself carries the model. Files over ~450 KB get a `?url=` link to a
  hosted copy instead.
- Up-axis toggle: Y-up by default (3D/optics convention), Z-up for CAD.

## Sample model credits

- `samples/jwst.glb`: James Webb Space Telescope, from
  [NASA 3D Resources](https://science.nasa.gov/3d-resources/)
  ([source](https://github.com/nasa/NASA-3D-Resources/tree/master/3D%20Models/James%20Webb%20Space%20Telescope%20%28B%29)).
  Courtesy of NASA; use does not imply NASA endorsement.
- `samples/voyager.glb`: Voyager probe, also from
  [NASA 3D Resources](https://science.nasa.gov/3d-resources/). Same
  terms as above.
- `samples/toy_car.glb`: ToyCar by Guido Odendahl and Eric Chadwick,
  [CC0](https://creativecommons.org/publicdomain/zero/1.0/), from the
  [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
  repo. Unmodified.

The viewer shows the credit for whichever sample is loaded, in the status
line and the lower-left corner.

## Run it

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Any static server works. (`file://` works too except the module imports;
serve over HTTP for reliability.)

## Deploy to Cloudflare Pages

The whole folder is the site. Drag it onto a Pages project or point Pages
at a git repo; build command: none, output directory: `/`.

## How it works

`viewer.js` is one ES module. Three.js renders; `OrbitControls` handles
the camera. For B-rep formats the file bytes go to
`occt.ReadStepFile()` / `ReadIgesFile` / `ReadBrepFile`, which return
triangulated meshes with part names; each part becomes a
`BufferGeometry`. fflate (gzip) powers the share link.

## Roadmap

- [ ] Measurement on edges/faces, not just surface points
- [ ] Explode view for assemblies
- [ ] OBJ MTL / glTF material passthrough
