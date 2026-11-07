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
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { PLYExporter } from 'three/addons/exporters/PLYExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { gunzipSync, gzipSync } from 'three/addons/libs/fflate.module.js';

const OCCT_VERSION = '0.0.22';
const OCCT_BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;
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
renderer.localClippingEnabled = true;
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
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

const state = { wireframe: false, edges: true, measuring: false, up: 'y' };

function setUp(axis) {
  state.up = axis;
  camera.up.set(0, axis === 'z' ? 0 : 1, axis === 'z' ? 1 : 0);
  grid.rotation.set(axis === 'z' ? Math.PI / 2 : 0, 0, 0);
  frameModel();
}
const parts = [];   // { name, mesh, edges, color }
let lastFile = null;
let modelScale = 1;

const tree = document.getElementById('tree');
const treeFoot = document.getElementById('treeFoot');

function rebuildTree() {
  tree.innerHTML = '';
  if (!parts.length) {
    tree.innerHTML = '<div class="empty">no model — drop a file or open the sample</div>';
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
  rebuildTree();
}

function addMesh(geom, name, color = null, material = null) {
  if (!geom.getAttribute('normal')) geom.computeVertexNormals();
  const m = material || baseMat.clone();
  if (color) m.color.copy(color);
  m.wireframe = state.wireframe;
  const mesh = new THREE.Mesh(geom, m);
  model.add(mesh);
  let edges = null;
  if (state.edges) {
    edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 30), edgeMat);
    model.add(edges);
  }
  parts.push({ name, mesh, edges, color: m.color.clone() });
  return mesh;
}

function frameModel() {
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  modelScale = s.length();
  controls.target.copy(c);
  const off = state.up === 'z'
    ? new THREE.Vector3(1, -1.2, 0.8)
    : new THREE.Vector3(1, 0.7, -1.2);
  camera.position.copy(c).add(
    off.normalize().multiplyScalar(modelScale * 1.3));
  camera.near = modelScale / 500; camera.far = modelScale * 20;
  camera.updateProjectionMatrix();
  document.getElementById('info').textContent =
    `drop a file anywhere · step/iges/brep · stl/obj/ply/3mf/gltf\n` +
    `dims ${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm (assumed)`;
  const sl = document.getElementById('sectSlider');
  sl.min = box.min.z - 0.05 * s.z; sl.max = box.max.z + 0.05 * s.z;
  sl.step = s.z / 200; sl.value = box.max.z + 0.05 * s.z;
}

// ---------- loaders ----------
let occt = null;
async function occtModule() {
  if (!occt) {
    const mod = await import(`${OCCT_BASE}occt-import-js.js`);
    occt = await mod.default({ locateFile: f => OCCT_BASE + f });
  }
  return occt;
}

function addOcctMeshes(result) {
  (result.meshes || []).forEach((m, i) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal)
      g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    if (m.index) g.setIndex(m.index.array);
    const color = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : null;
    addMesh(g, m.name || `part ${i + 1}`, color);
  });
}

function addGroupMeshes(group, fallbackName) {
  let i = 0;
  group.traverse(o => {
    if (o.isMesh) {
      o.geometry.applyMatrix4(o.matrixWorld);
      addMesh(o.geometry, o.name || `${fallbackName} ${++i}`,
        o.material?.color?.clone?.() ?? null);
    }
  });
}

const BREP_EXTS = ['step', 'stp', 'iges', 'igs', 'brep'];

async function loadBytes(name, bytes) {
  const ext = name.split('.').pop().toLowerCase();
  lastFile = { name, bytes, ext };
  if (bytes.length > BIG_FILE)
    status(`${name}: ${(bytes.length / 1e6).toFixed(0)} MB — over the ~100 MB comfort limit for in-browser parsing, this may be slow or fail…`);
  else
    status(`${name} (${(bytes.length / 1024).toFixed(0)} KB)…`);
  const asAB = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    if (ext === 'stl') {
      addMesh(new STLLoader().parse(asAB()), name);
    } else if (ext === 'obj') {
      addGroupMeshes(new OBJLoader().parse(new TextDecoder().decode(bytes)), name);
    } else if (ext === 'ply') {
      addMesh(new PLYLoader().parse(asAB()), name);
    } else if (ext === '3mf') {
      addGroupMeshes(new ThreeMFLoader().parse(asAB()), name);
    } else if (ext === 'gltf' || ext === 'glb') {
      const gltf = await new Promise((ok, err) =>
        new GLTFLoader().parse(asAB(), '', ok, err));
      addGroupMeshes(gltf.scene, name);
    } else if (BREP_EXTS.includes(ext)) {
      status(`${name}: parsing with OpenCascade (WASM)…`);
      const oc = await occtModule();
      const res = ext.startsWith('ig')
        ? oc.ReadIgesFile(bytes, null)
        : ext === 'brep' ? oc.ReadBrepFile(bytes, null)
        : oc.ReadStepFile(bytes, null);
      if (!res.success) throw new Error('OpenCascade could not parse the file');
      addOcctMeshes(res);
    } else {
      throw new Error(`.${ext} not supported`);
    }
    frameModel();
    rebuildTree();
    status(`${name} ✓`);
  } catch (e) {
    status(`${name}: ${e.message}`, true);
  }
}

const loadFile = async f => loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));

// ---------- sample ----------
function loadSample() {
  clearModel();
  const plate = new THREE.BoxGeometry(60, 40, 4); plate.translate(0, 0, 2);
  const boss = new THREE.CylinderGeometry(10, 10, 18, 48); boss.rotateX(Math.PI / 2); boss.translate(0, -8, 13);
  const dome = new THREE.SphereGeometry(9, 48, 32); dome.scale(1, 1, 0.6); dome.translate(12, 10, 4);
  addMesh(plate, 'base-plate', new THREE.Color(0x9db8c9));
  addMesh(boss, 'boss', new THREE.Color(0xd4a05a));
  addMesh(dome, 'dome', new THREE.Color(0x7ab87a));
  frameModel(); rebuildTree();
  status('sample assembly — try Measure / Section / parts tree / Export');
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
document.getElementById('sampleBtn').onclick = loadSample;
document.getElementById('fitBtn').onclick = frameModel;
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
togg('sectBtn', () => {
  const on = document.getElementById('sectCtl').classList.toggle('show');
  const planes = on ? [clipPlane] : [];
  model.traverse(o => { if (o.material) o.material.clippingPlanes = planes; });
});
document.getElementById('sectSlider').oninput = e => { clipPlane.constant = +e.target.value; };

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
