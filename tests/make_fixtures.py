#!/usr/bin/env python3
"""Generate test fixtures for the 3d-file-viewer test suite.

Mesh fixtures (cube.stl/.obj/.ply/.3mf/.glb, sphere.stl) are generated here
and committed. B-rep fixtures (cube.stp/.igs/.brep) are fetched from the
occt-import-js test corpus (LGPL-2.1, same parser the viewer uses) and are
gitignored; run this script to fetch them:

    python3 tests/make_fixtures.py

All fixtures are a 10x10x10 cube (or a UV sphere) so tests can assert exact
triangle counts.
"""
import json
import struct
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures"

# A 10x10x10 cube centered on the origin.
V = [
    (-5, -5, -5), (5, -5, -5), (5, 5, -5), (-5, 5, -5),
    (-5, -5, 5), (5, -5, 5), (5, 5, 5), (-5, 5, 5),
]
# 12 triangles, CCW outward. Each entry is a 3-tuple of vertex indices.
F = [
    (0, 2, 1), (0, 3, 2),  # -z
    (4, 5, 6), (4, 6, 7),  # +z
    (0, 1, 5), (0, 5, 4),  # -y
    (2, 3, 7), (2, 7, 6),  # +y
    (0, 4, 7), (0, 7, 3),  # -x
    (1, 2, 6), (1, 6, 5),  # +x
]


def tri_normal(a, b, c):
    import numpy as np
    u = np.array(b, dtype=float) - np.array(a, dtype=float)
    v = np.array(c, dtype=float) - np.array(a, dtype=float)
    n = np.cross(u, v)
    norm = np.linalg.norm(n)
    if norm == 0:
        return np.array([0.0, 0.0, 1.0])
    n /= norm
    return n


def write_stl(path, verts, faces, name="fixture"):
    lines = [f"solid {name}"]
    for f in faces:
        n = tri_normal(verts[f[0]], verts[f[1]], verts[f[2]])
        lines.append(f"  facet normal {n[0]:.6e} {n[1]:.6e} {n[2]:.6e}")
        lines.append("    outer loop")
        for i in f:
            x, y, z = verts[i]
            lines.append(f"      vertex {x:.6e} {y:.6e} {z:.6e}")
        lines.append("    endloop")
        lines.append("  endfacet")
    lines.append(f"endsolid {name}")
    path.write_text("\n".join(lines) + "\n")


def write_obj(path, verts, faces):
    lines = [f"o {path.stem}"]
    for x, y, z in verts:
        lines.append(f"v {x} {y} {z}")
    for f in faces:
        lines.append("f " + " ".join(str(i + 1) for i in f))
    path.write_text("\n".join(lines) + "\n")


def write_ply(path, verts, faces):
    lines = [
        "ply",
        "format ascii 1.0",
        f"element vertex {len(verts)}",
        "property float x",
        "property float y",
        "property float z",
        f"element face {len(faces)}",
        "property list uchar int vertex_indices",
        "end_header",
    ]
    for x, y, z in verts:
        lines.append(f"{x} {y} {z}")
    for f in faces:
        lines.append("3 " + " ".join(str(i) for i in f))
    path.write_text("\n".join(lines) + "\n")


def write_3mf(path, verts, faces):
    content_types = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
"""
    rels = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
"""
    verts_xml = "\n".join(
        f'          <vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in verts)
    tris_xml = "\n".join(
        f'          <triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in faces)
    model_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
{verts_xml}
        </vertices>
        <triangles>
{tris_xml}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>
"""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model_xml)


def write_glb(path, verts, faces):
    """Minimal binary glTF 2.0: one mesh, POSITION + indices, no material."""
    positions = struct.pack("<24f", *[c for v in verts for c in v])
    indices = struct.pack("<36H", *[i for f in faces for i in f])
    bin_data = positions + indices
    gltf = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(verts),
             "type": "VEC3", "min": [-5, -5, -5], "max": [5, 5, 5]},
            {"bufferView": 1, "componentType": 5123, "count": len(faces) * 3,
             "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(positions)},
            {"buffer": 0, "byteOffset": len(positions), "byteLength": len(indices)},
        ],
        "buffers": [{"byteLength": len(bin_data)}],
    }
    json_data = json.dumps(gltf, separators=(",", ":")).encode()
    json_pad = (4 - len(json_data) % 4) % 4
    bin_pad = (4 - len(bin_data) % 4) % 4
    total = 12 + 8 + len(json_data) + json_pad + 8 + len(bin_data) + bin_pad
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<II", len(json_data) + json_pad, 0x4E4F534A))
        f.write(json_data + b" " * json_pad)
        f.write(struct.pack("<II", len(bin_data) + bin_pad, 0x004E4942))
        f.write(bin_data + b"\x00" * bin_pad)


def write_sphere_stl(path, rings=12, segments=24):
    """UV sphere, 2*rings*segments triangles."""
    import numpy as np
    verts, faces = [], []
    for r in range(rings + 1):
        phi = np.pi * r / rings
        for s in range(segments):
            theta = 2 * np.pi * s / segments
            verts.append((5 * np.sin(phi) * np.cos(theta),
                          5 * np.sin(phi) * np.sin(theta),
                          5 * np.cos(phi)))
    for r in range(rings):
        for s in range(segments):
            a = r * segments + s
            b = a + segments
            nxt = (s + 1) % segments
            off = nxt - s
            faces.append((a, b, b + off))
            faces.append((a, b + off, a + off))
    write_stl(path, verts, faces, name="sphere")


# B-rep fixtures from the occt-import-js test corpus (LGPL-2.1).
# https://github.com/kovacsv/occt-import-js/tree/main/test/testfiles
BREP_SOURCES = {
    "cube.stp": "test/testfiles/simple-basic-cube/cube.stp",
    "cube.igs": "test/testfiles/cube-10x10mm/Cube%2010x10.igs",
    "cube.brep": "test/testfiles/cax-if-brep/as1_pe_203.brep",
}
BREP_RAW = "https://raw.githubusercontent.com/kovacsv/occt-import-js/main/{}"


def fetch_brep_fixtures():
    FIX.mkdir(exist_ok=True)
    for name, rel in BREP_SOURCES.items():
        dest = FIX / name
        if dest.exists():
            print(f"  {name}: exists")
            continue
        url = BREP_RAW.format(rel)
        print(f"  {name}: fetching {url}")
        with urllib.request.urlopen(url) as r:
            dest.write_bytes(r.read())


def main():
    FIX.mkdir(exist_ok=True)
    write_stl(FIX / "cube.stl", V, F)
    write_obj(FIX / "cube.obj", V, F)
    write_ply(FIX / "cube.ply", V, F)
    write_3mf(FIX / "cube.3mf", V, F)
    write_glb(FIX / "cube.glb", V, F)
    write_sphere_stl(FIX / "sphere.stl")
    print(f"generated mesh fixtures in {FIX}")
    print("fetching B-rep fixtures (LGPL-2.1, gitignored):")
    fetch_brep_fixtures()


if __name__ == "__main__":
    main()
