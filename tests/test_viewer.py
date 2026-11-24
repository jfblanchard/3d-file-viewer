"""Playwright test suite for 3d-file-viewer.

Run:  python3 -m pytest tests/ -v

Requires: python playwright + chromium (`playwright install chromium`),
and network access for the jsDelivr CDN (three.js, occt-import-js).
B-rep fixtures are fetched by `python3 tests/make_fixtures.py` (gitignored).
"""
import functools
import http.server
import socketserver
import threading
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"

MESH_FORMATS = ["stl", "obj", "ply", "3mf", "glb"]
BREP_FORMATS = ["stp", "igs", "brep"]
EXPORT_FORMATS = ["glb", "stl", "obj", "ply"]

CUBE_TRIS = 12
SPHERE_TRIS = 576  # 12 rings x 24 segments x 2


@pytest.fixture(scope="session")
def server():
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        yield f"http://127.0.0.1:{port}"
        httpd.shutdown()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture()
def page(browser, server):
    ctx = browser.new_context(accept_downloads=True,
                              permissions=["clipboard-read", "clipboard-write"])
    pg = ctx.new_page()
    pg.goto(server + "/")
    pg.wait_for_function(
        "/^sample: .*✓/.test(document.getElementById('status').textContent)",
        timeout=60_000)
    yield pg
    ctx.close()


def tri_count(page):
    return page.evaluate(
        "window.__viewer.parts.reduce((n,p)=>n+"
        "(p.mesh.geometry.index ? p.mesh.geometry.index.count "
        ": p.mesh.geometry.attributes.position.count)/3, 0)")


def part_names(page):
    return page.evaluate("window.__viewer.parts.map(p => p.name)")


def load(page, path, timeout=90_000):
    # clear first: the sample's status line already contains a ✓
    page.evaluate("document.getElementById('status').textContent = ''")
    page.set_input_files("#fileInput", str(path))
    page.wait_for_function(
        "document.getElementById('status').textContent.includes('✓')",
        timeout=timeout)


def test_sample_loads(page):
    # default sample: NASA James Webb Space Telescope, credited in the status
    assert len(part_names(page)) > 10
    assert tri_count(page) > 50_000
    assert "NASA" in page.text_content("#status")
    assert "NASA" in page.text_content("#info")


def test_sample_voyager_credit(page):
    page.select_option("#sampleSel", "voyager")
    page.wait_for_function(
        "document.getElementById('status').textContent.includes('Voyager probe ✓')")
    assert tri_count(page) > 0
    assert "NASA" in page.text_content("#status")
    assert "NASA" in page.text_content("#info")


def test_section_removed(page):
    assert page.query_selector("#sectBtn") is None


@pytest.mark.parametrize("fmt", MESH_FORMATS)
def test_load_mesh_format(page, fmt):
    load(page, FIX / f"cube.{fmt}")
    if fmt in ("3mf", "glb"):  # loaders assign their own part names
        assert len(part_names(page)) == 1
    else:
        assert part_names(page) == ["cube"]
    assert tri_count(page) == CUBE_TRIS


def test_load_sphere_stl(page):
    load(page, FIX / "sphere.stl")
    assert tri_count(page) == SPHERE_TRIS


@pytest.mark.parametrize("fmt", BREP_FORMATS)
def test_load_brep_format(page, fmt):
    load(page, FIX / f"cube.{fmt}", timeout=120_000)
    assert len(part_names(page)) >= 1
    assert tri_count(page) > 0


@pytest.mark.parametrize("fmt", EXPORT_FORMATS)
def test_export_roundtrip(page, tmp_path, fmt):
    load(page, FIX / "sphere.stl")
    assert tri_count(page) == SPHERE_TRIS
    with page.expect_download() as dl:
        page.select_option("#exportSel", fmt)
    out = tmp_path / f"sphere.{fmt}"
    dl.value.save_as(out)
    assert out.stat().st_size > 0
    load(page, out)
    assert tri_count(page) == SPHERE_TRIS


def test_share_link_roundtrip(page, server):
    load(page, FIX / "cube.stl")
    page.click("#shareBtn")
    url = page.evaluate("navigator.clipboard.readText()")
    assert url.startswith(server + "/#") and ";gz=" in url
    ctx = page.context
    pg2 = ctx.new_page()
    pg2.goto(url)
    pg2.wait_for_function(
        "document.getElementById('status').textContent.includes('✓')",
        timeout=90_000)
    assert tri_count(pg2) == CUBE_TRIS
    pg2.close()


def test_url_param(page, server):
    page.goto(server + "/?url=" + server + "/tests/fixtures/cube.stl")
    page.wait_for_function(
        "document.getElementById('status').textContent.includes('✓')",
        timeout=90_000)
    assert part_names(page) == ["cube"]
    assert tri_count(page) == CUBE_TRIS
