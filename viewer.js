// 3d-file-viewer — general-purpose 3D files in the browser.
// B-rep formats (STEP/IGES/BRep) via occt-import-js (OpenCascade->WASM);
// mesh formats via three.js loaders. Static site, ES modules + CDN.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { PLYExporter } from 'three/addons/exporters/PLYExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { gunzipSync, gzipSync } from 'three/addons/libs/fflate.module.js';

const OCCT_VERSION = '0.0.22';
const OCCT_BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;
const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/';
const SHARE_MAX = 450 * 1024;
const BIG_FILE = 100 * 1024 * 1024; // soft limit — WASM memory, not a hard cap

const status = (msg, isErr = false) => {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = isErr ? 'err' : '';
};

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
scene.environment = new THREE.PMREMGenerator(renderer)
  .fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 5000);
camera.position.set(60, -70, 55);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x30404f, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(1, 0.8, 1.5);
scene.add(dir);

const grid = new THREE.GridHelper(100, 20, 0x3a4048, 0x262a31);
// default Y-up (3D/optics convention); Z-up selectable in the HUD
scene.add(grid);
const axes = new THREE.AxesHelper(15);
scene.add(axes);

const model = new THREE.Group();
scene.add(model);
const markup = new THREE.Group();
scene.add(markup);

// ---------- orientation gizmo (lower-right corner viewport) ----------
const gizmoScene = new THREE.Scene();
const gizmoCam = new THREE.OrthographicCamera(-2.2, 2.2, 2.2, -2.2, 0.1, 50);
{
  const mk = (dirV, color, letter) => {
    const a = new THREE.ArrowHelper(dirV, new THREE.Vector3(), 1.35, color, 0.42, 0.28);
    gizmoScene.add(a);
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    c.font = '700 46px system-ui';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#cfd4dc';
    c.fillText(letter, 32, 34);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
    sp.scale.setScalar(0.9);
    sp.position.copy(dirV.clone().multiplyScalar(1.95));
    gizmoScene.add(sp);
  };
  mk(new THREE.Vector3(1, 0, 0), 0xe5534b, 'X');
  mk(new THREE.Vector3(0, 1, 0), 0x57ab5a, 'Y');
  mk(new THREE.Vector3(0, 0, 1), 0x539bf5, 'Z');
}

// ---------- materials / parts ----------
const baseMat = new THREE.MeshStandardMaterial({
  color: 0x9db8c9, metalness: 0.15, roughness: 0.6,
  side: THREE.DoubleSide,
});
const edgeMat = new THREE.LineBasicMaterial({ color: 0x16222c, transparent: true, opacity: 0.55 });

const state = { wireframe: false, edges: true, measuring: false, up: 'y' };

function setUp(axis) {
  state.up = axis;
  camera.up.set(0, axis === 'z' ? 0 : 1, axis === 'z' ? 1 : 0);
  grid.rotation.set(axis === 'z' ? Math.PI / 2 : 0, 0, 0);
  frameModel();
}
const parts = [];   // { name, mesh, edges, color }
const mainCtx = { group: model, parts, wantEdges: true };
let lastFile = null;
let modelScale = 1;
let credit = '';    // attribution line for bundled sample models

const tree = document.getElementById('tree');
const treeFoot = document.getElementById('treeFoot');

function rebuildTree() {
  tree.innerHTML = '';
  if (!parts.length) {
    tree.innerHTML = '<div class="empty">no model: drop a file or pick a sample</div>';
    treeFoot.textContent = '';
    return;
  }
  parts.forEach(p => {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true;
    cb.onchange = () => {
      p.mesh.visible = cb.checked;
      if (p.edges) p.edges.visible = cb.checked && state.edges;
      lab.classList.toggle('hidden-part', !cb.checked);
    };
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = '#' + p.color.getHexString();
    const nm = document.createElement('span');
    nm.textContent = p.name;
    nm.title = p.name;
    lab.append(cb, sw, nm);
    tree.append(lab);
  });
  const tri = parts.reduce((n, p) => n + (p.mesh.geometry.index
    ? p.mesh.geometry.index.count : p.mesh.geometry.attributes.position.count) / 3, 0);
  treeFoot.textContent = `${parts.length} part${parts.length > 1 ? 's' : ''} · ${(tri / 1000).toFixed(0)}k tris`;
}

function clearModel() {
  model.traverse(o => o.geometry?.dispose?.());
  model.clear();
  markup.clear();
  parts.length = 0;
  lastFile = null;
  credit = '';
  rebuildTree();
}

function addMesh(geom, name, color = null, material = null, ctx = mainCtx) {
  if (!geom.getAttribute('normal')) geom.computeVertexNormals();
  const m = material || baseMat.clone();
  if (color) m.color.copy(color);
  m.wireframe = state.wireframe;
  const mesh = new THREE.Mesh(geom, m);
  ctx.group.add(mesh);
  let edges = null;
  if (state.edges && ctx.wantEdges) {
    edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 30), edgeMat);
    ctx.group.add(edges);
  }
  ctx.parts.push({ name, mesh, edges, color: m.color.clone() });
  return mesh;
}

function frameModel(view = null) {
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  modelScale = s.length();
  axes.scale.setScalar(modelScale * 0.2 / 15);  // axes sized to the model
  controls.target.copy(c);
  const off = view ? view.clone() : state.up === 'z'
    ? new THREE.Vector3(1, -1.2, 0.8)
    : new THREE.Vector3(1, 0.7, -1.2);
  camera.position.copy(c).add(
    off.normalize().multiplyScalar(modelScale * 1.3));
  camera.near = modelScale / 500; camera.far = modelScale * 20;
  camera.updateProjectionMatrix();
  document.getElementById('info').textContent =
    `drop a file anywhere · step/iges/brep · stl/obj/ply/3mf/gltf\n` +
    `dims ${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm (assumed)` +
    (credit ? `\n${credit}` : '');
}

// ---------- loaders ----------
let occt = null;
async function occtModule() {
  if (!occt) {
    const mod = await import(`https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/+esm`);
    occt = await mod.default({ locateFile: f => OCCT_BASE + f });
  }
  return occt;
}

function addOcctMeshes(result, ctx = mainCtx) {
  (result.meshes || []).forEach((m, i) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal)
      g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    if (m.index) g.setIndex(m.index.array);
    const color = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : null;
    addMesh(g, m.name || `part ${i + 1}`, color, null, ctx);
  });
}

function addGroupMeshes(group, fallbackName, ctx = mainCtx) {
  group.updateMatrixWorld(true);
  let i = 0;
  group.traverse(o => {
    if (o.isMesh) {
      o.geometry.applyMatrix4(o.matrixWorld);
      // glTF splits a multi-primitive mesh into siblings named Mesh_0_1, _2…;
      // the material name says more about which part it is.
      const multi = o.parent && o.parent.children.filter(c => c.isMesh).length > 1;
      const nm = (multi && o.material?.name) || o.name || `${fallbackName} ${++i}`;
      addMesh(o.geometry, nm,
        o.material?.color?.clone?.() ?? null, null, ctx);
    }
  });
}

// glTF loader with Draco + Meshopt decoders (compressed GLBs, e.g. NASA's)
let gltf_ = null;
function gltfLoader() {
  if (!gltf_) {
    gltf_ = new GLTFLoader()
      .setDRACOLoader(new DRACOLoader().setDecoderPath(DRACO_PATH))
      .setMeshoptDecoder(MeshoptDecoder);
  }
  return gltf_;
}

const BREP_EXTS = ['step', 'stp', 'iges', 'igs', 'brep'];

// Parse file bytes into a target context {group, parts, wantEdges} without
// touching the main scene. ctx defaults to the live model (mainCtx); the
// folder-browser thumbnails parse into a temporary group.
async function parseBytes(name, bytes, ctx) {
  const ext = name.split('.').pop().toLowerCase();
  const stem = name.replace(/\.[^.]+$/, '');
  const asAB = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (ext === 'stl') {
    addMesh(new STLLoader().parse(asAB()), stem, null, null, ctx);
  } else if (ext === 'obj') {
    addGroupMeshes(new OBJLoader().parse(new TextDecoder().decode(bytes)), stem, ctx);
  } else if (ext === 'ply') {
    addMesh(new PLYLoader().parse(asAB()), stem, null, null, ctx);
  } else if (ext === '3mf') {
    addGroupMeshes(new ThreeMFLoader().parse(asAB()), stem, ctx);
  } else if (ext === 'gltf' || ext === 'glb') {
    const gltf = await new Promise((ok, err) => gltfLoader().parse(asAB(), '', ok, err));
    addGroupMeshes(gltf.scene, stem, ctx);
  } else if (BREP_EXTS.includes(ext)) {
    const oc = await occtModule();
    const res = ext.startsWith('ig')
      ? oc.ReadIgesFile(bytes, null)
      : ext === 'brep' ? oc.ReadBrepFile(bytes, null)
      : oc.ReadStepFile(bytes, null);
    if (!res.success) throw new Error('OpenCascade could not parse the file');
    addOcctMeshes(res, ctx);
  } else {
    throw new Error(`.${ext} not supported`);
  }
}

async function loadBytes(name, bytes) {
  const ext = name.split('.').pop().toLowerCase();
  lastFile = { name, bytes, ext };
  if (bytes.length > BIG_FILE)
    status(`${name}: ${(bytes.length / 1e6).toFixed(0)} MB — over the ~100 MB comfort limit for in-browser parsing, this may be slow or fail…`);
  else
    status(`${name} (${(bytes.length / 1024).toFixed(0)} KB)…`);
  try {
    if (BREP_EXTS.includes(ext)) status(`${name}: parsing with OpenCascade (WASM)…`);
    await parseBytes(name, bytes, mainCtx);
    frameModel();
    rebuildTree();
    status(`${name} ✓`);
    return true;
  } catch (e) {
    status(`${name}: ${e.message}`, true);
    return false;
  }
}

const loadFile = async f => loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));

// ---------- samples ----------
// Bundled models, served from samples/. Credits show in the status line,
// the corner overlay and the README.
const SAMPLES = {
  jwst: {
    file: 'samples/jwst.glb', label: 'James Webb Space Telescope', by: 'NASA',
    view: new THREE.Vector3(-1.1, 0.5, 1),   // mirror side
    credit: 'model: NASA 3D Resources (science.nasa.gov/3d-resources)',
  },
  voyager: {
    file: 'samples/voyager.glb', label: 'Voyager probe', by: 'NASA',
    view: new THREE.Vector3(1, 0.5, 1),
    credit: 'model: NASA 3D Resources (science.nasa.gov/3d-resources)',
  },
  toy_car: {
    file: 'samples/toy_car.glb', label: 'Toy car', by: 'CC0, Khronos samples',
    view: new THREE.Vector3(1, 0.7, 1.2),
    credit: 'model: ToyCar by Guido Odendahl / Eric Chadwick, CC0 (Khronos glTF-Sample-Assets)',
  },
};

async function loadSample(key = 'jwst') {
  const smp = SAMPLES[key];
  clearModel();
  status(`loading sample: ${smp.label}…`);
  try {
    const r = await fetch(smp.file);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    credit = smp.credit;
    const ok = await loadBytes(smp.file.split('/').pop(), new Uint8Array(await r.arrayBuffer()));
    if (ok) {
      if (state.up === 'y') frameModel(smp.view);
      status(`sample: ${smp.label} ✓ (${smp.by})`);
    }
  } catch (e) {
    status(`sample ${smp.label}: ${e.message}`, true);
  }
}

// ---------- folder browser ----------
// File System Access API (Chromium only): "Folder…" picks a directory, the
// sidebar lists every supported file under it with a rendered thumbnail,
// and a row click loads it. Files never leave the browser; the picker hands
// back File objects.
const folderEl = document.getElementById('folder');
const folderBtn = document.getElementById('folderBtn');
const ALL_EXTS = [...BREP_EXTS, 'stl', 'obj', 'ply', '3mf', 'gltf', 'glb'];
const thumbQueue = [];
let thumbBusy = false;

if (!('showDirectoryPicker' in window)) {
  folderBtn.disabled = true;
  folderBtn.title = 'Folder browsing needs a Chromium-based browser (Chrome, Edge, Arc)';
}

async function* walkDir(dir, prefix = '') {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'file') {
      const ext = name.split('.').pop().toLowerCase();
      if (ALL_EXTS.includes(ext)) yield { handle: h, name, path: prefix + name, ext };
    } else if (h.kind === 'directory') {
      yield* walkDir(h, prefix + name + '/');
    }
  }
}

folderBtn.onclick = async () => {
  let root;
  try { root = await showDirectoryPicker(); } catch { return; }  // cancelled
  thumbQueue.length = 0;
  folderEl.innerHTML = '';
  status(`scanning ${root.name}…`);
  let n = 0;
  for await (const e of walkDir(root)) { addFolderRow(e); n++; }
  status(n ? `${root.name}: ${n} 3D file${n > 1 ? 's' : ''}` : `${root.name}: no supported files`);
  if (!n) folderEl.innerHTML = '<div class="empty">no supported 3D files here</div>';
};

const thumbIO = ('IntersectionObserver' in window)
  ? new IntersectionObserver(es => es.forEach(en => {
      if (en.isIntersecting) {
        thumbIO.unobserve(en.target);
        thumbQueue.push(en.target._entry);
        pumpThumbs();
      }
    }), { root: folderEl })
  : null;

function addFolderRow(e) {
  const row = document.createElement('div');
  row.className = 'frow';
  row.title = e.path;
  const img = document.createElement('img');
  img.className = 'fthumb';
  img.alt = e.ext;
  const label = document.createElement('span');
  label.className = 'fname';
  label.textContent = e.path;
  row.append(img, label);
  row._entry = e;
  row.onclick = async () => {
    document.querySelectorAll('.frow.active').forEach(r => r.classList.remove('active'));
    row.classList.add('active');
    try {
      clearModel();
      const f = await e.handle.getFile();
      await loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));
    } catch (err) { status(`${e.path}: ${err.message}`, true); }
  };
  e.img = img;
  folderEl.append(row);
  if (thumbIO) thumbIO.observe(row);
  else { thumbQueue.push(e); pumpThumbs(); }
}

async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length) {
    const e = thumbQueue.shift();
    try {
      const url = await renderThumb(e);
      if (url) e.img.src = url;
      else extBadge(e);
    } catch { extBadge(e); }
  }
  thumbBusy = false;
}

function extBadge(e) {
  const d = document.createElement('div');
  d.className = 'fthumb fext';
  d.textContent = e.ext;
  e.img.replaceWith(d);
}

// one shared offscreen renderer for all thumbnails
let thumbR = null;
function thumbRenderer() {
  if (!thumbR) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    r.setSize(96, 96, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x22252b);
    const cam = new THREE.PerspectiveCamera(40, 1, 0.001, 1e9);
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1, 1.4, 1.1);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-1.2, -0.6, -0.8);
    scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.5));
    thumbR = { r, scene, cam };
  }
  return thumbR;
}

async function renderThumb(e) {
  const f = await e.handle.getFile();
  const ctx = { group: new THREE.Group(), parts: [], wantEdges: false };
  await parseBytes(f.name, new Uint8Array(await f.arrayBuffer()), ctx);
  if (!ctx.parts.length) return null;
  const { r, scene, cam } = thumbRenderer();
  scene.add(ctx.group);
  const box = new THREE.Box3().setFromObject(ctx.group);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3()).length() || 1;
  cam.position.copy(c).add(
    new THREE.Vector3(1, 0.7, -1.2).normalize().multiplyScalar(s * 1.6));
  cam.near = s / 100; cam.far = s * 20;
  cam.updateProjectionMatrix();
  r.render(scene, cam);
  const url = r.domElement.toDataURL('image/png');
  scene.remove(ctx.group);
  ctx.group.traverse(o => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(mm => mm?.dispose?.());
  });
  return url;
}

// ---------- export ----------
const dl = (blob, filename) => {
  const a = Object.assign(document.createElement('a'),
    { href: URL.createObjectURL(blob), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

function meshesOnlyGroup() {
  const grp = new THREE.Group();
  for (const p of parts) {
    const m = p.mesh.clone();
    m.material = p.mesh.material.clone();
    m.material.wireframe = false;
    grp.add(m);
  }
  return grp;
}

async function exportModel(fmt) {
  if (!parts.length) { status('nothing to export', true); return; }
  const base = (lastFile?.name || 'model').replace(/\.[^.]+$/, '');
  const grp = meshesOnlyGroup();
  try {
    if (fmt === 'glb') {
      new GLTFExporter().parse(grp,
        r => dl(new Blob([r], { type: 'model/gltf-binary' }), base + '.glb'),
        e => { throw e; }, { binary: true });
    } else if (fmt === 'stl') {
      const r = new STLExporter().parse(grp, { binary: true });
      dl(new Blob([r], { type: 'model/stl' }), base + '.stl');
    } else if (fmt === 'obj') {
      dl(new Blob([new OBJExporter().parse(grp)], { type: 'text/plain' }), base + '.obj');
    } else if (fmt === 'ply') {
      new PLYExporter().parse(grp,
        r => dl(new Blob([r], { type: 'application/octet-stream' }), base + '.ply'),
        { binary: true });
    }
    const brepNote = lastFile && BREP_EXTS.includes(lastFile.ext)
      ? ' — exported as mesh; B-rep face data isn\'t carried through' : '';
    status(`exported ${base}.${fmt}${brepNote}`);
  } catch (e) {
    status(`export failed: ${e.message}`, true);
  }
}
document.getElementById('exportSel').onchange = e => {
  if (e.target.value) exportModel(e.target.value);
  e.target.value = '';
};

// ---------- measure ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const mPts = [];

function textSprite(text) {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  ctx.font = '600 40px system-ui';
  const w = Math.ceil(ctx.measureText(text).width) + 30;
  cv.width = w; cv.height = 56;
  const c2 = cv.getContext('2d');
  c2.fillStyle = 'rgba(20,22,26,.85)'; c2.fillRect(0, 0, w, 56);
  c2.font = '600 40px system-ui'; c2.fillStyle = '#ffd479';
  c2.fillText(text, 15, 42);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
  sp.scale.set(w * modelScale / 2500, 56 * modelScale / 2500, 1);
  return sp;
}

function onMeasureClick(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(model, true)[0];
  if (!hit) return;
  const r = modelScale / 250;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffd479 }));
  dot.position.copy(hit.point);
  markup.add(dot);
  mPts.push(hit.point.clone());
  if (mPts.length === 2) {
    const [a, b] = mPts;
    const d = a.distanceTo(b);
    markup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0xffd479 })));
    const lbl = textSprite(`${d.toFixed(2)} mm`);
    lbl.position.copy(a).add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 0, r * 6));
    markup.add(lbl);
    status(`distance ${d.toFixed(2)} mm`);
    mPts.length = 0;
  }
}
renderer.domElement.addEventListener('pointerdown', e => { if (state.measuring) onMeasureClick(e); });

// ---------- ui ----------
const togg = (id, fn) => document.getElementById(id).onclick = e => { fn(e.target); e.target.classList.toggle('active'); };
document.getElementById('sampleSel').onchange = e => {
  if (e.target.value) loadSample(e.target.value);
  e.target.value = '';
};
document.getElementById('fitBtn').onclick = () => frameModel();
document.getElementById('upSel').onchange = e => setUp(e.target.value);
togg('wireBtn', () => { state.wireframe = !state.wireframe; model.traverse(o => { if (o.isMesh) o.material.wireframe = state.wireframe; }); });
const eb = document.getElementById('edgeBtn'); eb.classList.add('active');
togg('edgeBtn', () => {
  state.edges = !state.edges;
  model.traverse(o => { if (o.isLineSegments) o.visible = state.edges; });
});
const gb = document.getElementById('gridBtn'); gb.classList.add('active');
togg('gridBtn', () => { grid.visible = !grid.visible; axes.visible = grid.visible; });
togg('measureBtn', () => {
  state.measuring = !state.measuring;
  controls.enableRotate = !state.measuring;
  markup.clear(); mPts.length = 0;
  status(state.measuring ? 'measure: click two points' : '');
});

document.getElementById('shotBtn').onclick = () => {
  renderer.render(scene, camera);
  renderer.domElement.toBlob(b => dl(b, 'view.png'));
};

document.getElementById('shareBtn').onclick = async () => {
  if (!lastFile) { status('load a file first (or use ?url=…)', true); return; }
  if (lastFile.bytes.length > SHARE_MAX) {
    status(`file too big to embed — host it and use ?url=`, true);
    return;
  }
  const gz = gzipSync(lastFile.bytes);
  const b64 = btoa(String.fromCharCode(...gz));
  const url = `${location.origin}${location.pathname}#${encodeURIComponent(lastFile.name)};gz=${b64}`;
  await navigator.clipboard.writeText(url);
  status(`link copied (${(url.length / 1024).toFixed(0)} KB URL)`);
};

// ---------- boot ----------
async function boot() {
  const q = new URLSearchParams(location.search);
  if (q.get('url')) {
    try {
      const r = await fetch(q.get('url'));
      loadBytes(q.get('url').split('/').pop().split('?')[0], new Uint8Array(await r.arrayBuffer()));
    } catch { status('?url= fetch failed (CORS?)', true); }
    return;
  }
  const h = location.hash.slice(1);
  const m = h.match(/^([^;]+);gz=(.+)$/);
  if (m) {
    try {
      const bytes = gunzipSync(Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)));
      loadBytes(decodeURIComponent(m[1]), bytes);
    } catch { status('bad share link', true); }
    return;
  }
  loadSample();
}

// ---------- drag & drop / file input / resize ----------
// keep the sidebar below the HUD when the toolbar wraps to two rows
{
  const hud = document.getElementById('hud'), side = document.getElementById('sidebar');
  new ResizeObserver(() => { side.style.top = hud.offsetHeight + 'px'; }).observe(hud);
}
document.getElementById('fileInput').onchange = e => {
  clearModel();
  [...e.target.files].forEach(loadFile);
  e.target.value = '';
};
const drop = document.getElementById('drop');
addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('show'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('show'); });
addEventListener('drop', e => {
  e.preventDefault(); drop.classList.remove('show');
  clearModel();
  [...e.dataTransfer.files].forEach(loadFile);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- render loop (main scene + gizmo corner viewport) ----------
const G = 110; // gizmo viewport px
function loop() {
  controls.update();
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.render(scene, camera);

  renderer.setScissorTest(true);
  const x = innerWidth - G - 10, y = 10;
  renderer.setViewport(x, y, G, G);
  renderer.setScissor(x, y, G, G);
  gizmoCam.quaternion.copy(camera.quaternion);
  gizmoCam.position.set(0, 0, 8).applyQuaternion(camera.quaternion);
  gizmoCam.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  renderer.render(gizmoScene, gizmoCam);
}
renderer.setAnimationLoop(loop);
boot();

// test hook — exact part/geometry state for the Playwright suite
window.__viewer = { parts, state, lastFile };
