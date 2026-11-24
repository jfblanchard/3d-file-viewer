// 3d-file-viewer — general-purpose 3D files in the browser.
// B-rep formats (STEP/IGES/BRep) via occt-import-js (OpenCascade->WASM);
// mesh formats via three.js loaders. Static site, ES modules + CDN.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { TeapotGeometry } from 'three/addons/geometries/TeapotGeometry.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { PLYExporter } from 'three/addons/exporters/PLYExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { gunzipSync, gzipSync, zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';

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

// ---------- zoom ----------
// OrbitControls' own wheel zoom proved erratic: its step scales with
// |deltaY| / (100 * devicePixelRatio), and input devices report wildly
// different deltas (see central-planning threejs-lessons.md). Rather than
// normalize events for it, zoom is fully owned here: OrbitControls' zoom
// is disabled (rotate/pan untouched) and wheel + pinch feed a damped
// accumulator. One notch eases to a ~4% step; a sustained scroll is
// velocity-clamped so it can never fly. Device- and version-proof by
// construction: there is no other zoom path.
controls.enableZoom = false;
let zoomVel = 0;                       // >0 zooms in, decays each frame
const ZOOM_STEP = 0.04;                // accumulated per wheel event

function dolly(f) {                    // f<1 zooms in, >1 zooms out
  const off = camera.position.clone().sub(controls.target);
  off.setLength(THREE.MathUtils.clamp(off.length() * f,
    controls.minDistance, controls.maxDistance));
  camera.position.copy(controls.target).add(off);
}

renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopPropagation();
  zoomVel = THREE.MathUtils.clamp(
    zoomVel - Math.sign(e.deltaY) * ZOOM_STEP, -1.5, 1.5);
}, { passive: false });

// two-finger pinch, same dolly path as the wheel (OrbitControls' pinch
// is off along with its zoom; its two-finger pan still works)
const activePtrs = new Map();
let lastPinch = 0;
const pinchReset = e => {
  activePtrs.delete(e.pointerId);
  if (activePtrs.size < 2) lastPinch = 0;
};
renderer.domElement.addEventListener('pointerdown',
  e => activePtrs.set(e.pointerId, [e.clientX, e.clientY]));
addEventListener('pointerup', pinchReset);
addEventListener('pointercancel', pinchReset);
renderer.domElement.addEventListener('pointermove', e => {
  if (!activePtrs.has(e.pointerId)) return;
  activePtrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (activePtrs.size < 2) return;
  const [a, b] = [...activePtrs.values()];
  const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (lastPinch) dolly(THREE.MathUtils.clamp(lastPinch / d, 0.92, 1.09));
  lastPinch = d;
});

// called from the render loop: drain ~18% of accumulated zoom per frame
function applyZoom() {
  if (Math.abs(zoomVel) < 1e-4) { zoomVel = 0; return; }
  const step = zoomVel * 0.18;
  zoomVel -= step;
  dolly(1 - step);
}

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

const state = { wireframe: false, edges: true, up: 'y' };

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
const nameEl = document.getElementById('modelName');

// Parts are grouped into a collapsible tree by shared name tokens
// (JWST-bracket1-fl + JWST-bracket1-sm group under JWST > bracket1).
// Group checkboxes toggle every descendant part; indeterminate when mixed.
function rebuildTree() {
  tree.innerHTML = '';
  if (!parts.length) {
    tree.innerHTML = '<div class="empty">no model: drop a file or pick a sample</div>';
    treeFoot.textContent = '';
    return;
  }
  const items = parts.map(p => ({ p, tokens: p.name.split(/[-_.\s]+/).filter(Boolean) }));
  tree.append(renderLevel(buildLevel(items, 0), parts.length > 12));
  const tri = parts.reduce((n, p) => n + (p.mesh.geometry.index
    ? p.mesh.geometry.index.count : p.mesh.geometry.attributes.position.count) / 3, 0);
  treeFoot.textContent = `${parts.length} part${parts.length > 1 ? 's' : ''} · ${(tri / 1000).toFixed(0)}k tris`;
}

function buildLevel(items, depth) {
  const out = [], buckets = new Map();
  for (const it of items) {
    const k = it.tokens[depth];
    if (k === undefined) out.push({ leaf: { ...it, depth } });
    else {
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(it);
    }
  }
  for (const [label, b] of buckets)
    out.push(b.length === 1 ? { leaf: { ...b[0], depth } } : { label, kids: buildLevel(b, depth + 1) });
  return out;
}

const collectLeaves = n => n.leaf ? [n.leaf] : n.kids.flatMap(collectLeaves);

function setPartVisible(p, v) {
  p.mesh.visible = v;
  if (p.edges) p.edges.visible = v && state.edges;
}

// walk up from a row, recomputing each ancestor group's checked/indeterminate
function syncAncestorGroups(el) {
  for (let d = el.closest('details'); d; d = d.parentElement.closest('details')) {
    const boxes = [...d.querySelectorAll('label input')];
    const cb = d.querySelector(':scope > summary input');
    const on = boxes.filter(b => b.checked).length;
    cb.checked = on === boxes.length;
    cb.indeterminate = on > 0 && on < boxes.length;
  }
}

function leafRow({ p, tokens, depth }) {
  const lab = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = p.mesh.visible !== false;
  cb.onchange = () => {
    setPartVisible(p, cb.checked);
    lab.classList.toggle('hidden-part', !cb.checked);
    syncAncestorGroups(lab);
  };
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = '#' + p.color.getHexString();
  const nm = document.createElement('span');
  nm.textContent = depth === 0 ? p.name : (tokens.slice(depth).join('-') || p.name);
  nm.title = p.name;
  lab.append(cb, sw, nm);
  return lab;
}

function renderLevel(nodes, collapse) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    if (n.leaf) { frag.append(leafRow(n.leaf)); continue; }
    const leaves = collectLeaves(n);
    const det = document.createElement('details');
    if (!collapse) det.open = true;
    const sum = document.createElement('summary');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = leaves.every(l => l.p.mesh.visible !== false);
    cb.indeterminate = !cb.checked && leaves.some(l => l.p.mesh.visible !== false);
    cb.addEventListener('click', e => e.stopPropagation());  // don't toggle the details
    cb.onchange = () => {
      leaves.forEach(l => setPartVisible(l.p, cb.checked));
      det.querySelectorAll('label').forEach(l => {
        l.classList.toggle('hidden-part', !cb.checked);
        l.querySelector('input').checked = cb.checked;
      });
      det.querySelectorAll('summary input').forEach(c => { c.checked = cb.checked; c.indeterminate = false; });
      syncAncestorGroups(sum);
    };
    const nm = document.createElement('span');
    nm.className = 'gname'; nm.textContent = n.label; nm.title = n.label;
    const cnt = document.createElement('span');
    cnt.className = 'gcount'; cnt.textContent = `(${leaves.length})`;
    sum.append(cb, nm, cnt);
    const kids = document.createElement('div');
    kids.className = 'kids';
    kids.append(renderLevel(n.kids, collapse));
    det.append(sum, kids);
    frag.append(det);
  }
  return frag;
}

function clearModel() {
  model.traverse(o => o.geometry?.dispose?.());
  model.clear();
  parts.length = 0;
  lastFile = null;
  credit = '';
  nameEl.textContent = '';
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
  controls.minDistance = modelScale * 0.05;   // can't dolly inside the model
  controls.maxDistance = modelScale * 8;      // or out where it becomes a speck
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
    `dims ${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} (model units)` +
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
// touching the main scene. ctx defaults to the live model (mainCtx).
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

async function loadBytes(name, bytes, display = name) {
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
    nameEl.textContent = display;
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
  voyager: {
    file: 'samples/voyager.glb', label: 'Voyager probe', by: 'NASA',
    view: new THREE.Vector3(1, 0.5, 1),
    credit: 'model: NASA 3D Resources (science.nasa.gov/3d-resources)',
  },
  jwst: {
    file: 'samples/jwst.glb', label: 'James Webb Space Telescope', by: 'NASA',
    view: new THREE.Vector3(-1.1, 0.5, 1),   // mirror side
    credit: 'model: NASA 3D Resources (science.nasa.gov/3d-resources)',
  },
  teapot: {
    gen: () => new TeapotGeometry(5, 12), label: 'Utah teapot', by: 'Martin Newell',
    view: new THREE.Vector3(1, 0.6, 1.2),
    credit: 'model: Utah teapot, Martin Newell (University of Utah, public-domain data)',
  },
  bunny: {
    file: 'samples/bunny.ply', label: 'Stanford bunny', by: 'Stanford CG Lab',
    view: new THREE.Vector3(1.3, 0.5, 0.9),
    credit: 'model: Stanford bunny, Stanford University Computer Graphics Laboratory',
  },
};

async function loadSample(key = 'voyager') {
  const smp = SAMPLES[key];
  clearModel();
  status(`loading sample: ${smp.label}…`);
  try {
    credit = smp.credit;
    if (smp.gen) {   // procedural sample, no file to fetch
      addMesh(smp.gen(), smp.label);
      frameModel(state.up === 'y' ? smp.view : null);
      rebuildTree();
      nameEl.textContent = smp.label;
      status(`sample: ${smp.label} ✓ (${smp.by})`);
      return;
    }
    const r = await fetch(smp.file);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ok = await loadBytes(smp.file.split('/').pop(), new Uint8Array(await r.arrayBuffer()), smp.label);
    if (ok) {
      if (state.up === 'y') frameModel(smp.view);
      status(`sample: ${smp.label} ✓ (${smp.by})`);
    }
  } catch (e) {
    status(`sample ${smp.label}: ${e.message}`, true);
  }
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

// 3MF is a zip of XML: content types, a rels pointer, and one model file
// listing each part's vertices/triangles. Colors ride along as
// basematerials. Unit is declared millimeter, matching model-units dims.
function export3MF() {
  const esc = s => s.replace(/[<>&'"]/g, c =>
    `&#${c.charCodeAt(0)};`);
  const parts3mf = parts.filter(p => p.mesh.visible);
  if (!parts3mf.length) return null;
  const v = new THREE.Vector3();
  const objects = parts3mf.map((p, i) => {
    const g = p.mesh.geometry;
    const pos = g.attributes.position;
    const verts = [];
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(p.mesh.matrixWorld);
      verts.push(`<vertex x="${v.x}" y="${v.y}" z="${v.z}"/>`);
    }
    const tris = [];
    if (g.index) {
      for (let k = 0; k < g.index.count; k += 3)
        tris.push(`<triangle v1="${g.index.getX(k)}" v2="${g.index.getX(k + 1)}" v3="${g.index.getX(k + 2)}"/>`);
    } else {
      for (let k = 0; k < pos.count; k += 3)
        tris.push(`<triangle v1="${k}" v2="${k + 1}" v3="${k + 2}"/>`);
    }
    const c = p.mesh.material.color;
    const hex = n => Math.round(n * 255).toString(16).padStart(2, '0');
    return {
      xml: `<object id="${i + 2}" type="model" name="${esc(p.name || `part${i}`)}" pid="1" pindex="${i}">` +
        `<mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`,
      color: `#${hex(c.r)}${hex(c.g)}${hex(c.b)}FF`,
    };
  });
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources><basematerials id="1">${objects.map(o => `<base displaycolor="${o.color}"/>`).join('')}</basematerials>` +
    objects.map(o => o.xml).join('') + `</resources>` +
    `<build>${objects.map((_, i) => `<item objectid="${i + 2}"/>`).join('')}</build></model>`;
  const ct = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return zipSync({
    '3D/3dmodel.model': strToU8(modelXml),
    '[Content_Types].xml': strToU8(ct),
    '_rels/.rels': strToU8(rels),
  });
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
    } else if (fmt === '3mf') {
      const z = export3MF();
      if (!z) { status('nothing visible to export', true); return; }
      dl(new Blob([z], { type: 'model/3mf' }), base + '.3mf');
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
  new ResizeObserver(() => {
    side.style.top = hud.offsetHeight + 'px';
    nameEl.style.top = hud.offsetHeight + 8 + 'px';
  }).observe(hud);
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
  applyZoom();
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
window.__viewer = { parts, state, lastFile, camera, controls };
