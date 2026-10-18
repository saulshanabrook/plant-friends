from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytest
from PIL import Image

from tools.plant_assets import photos
from tools.plant_assets.catalog import write_json_asset

COMMIT = "a" * 40


@pytest.fixture
def source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    # Tiny explicit source/Git doubles; all image decoding and DB ownership joins are real.
    monkeypatch.setattr(subprocess, "check_output", lambda args, **kwargs: COMMIT if "rev-parse" in args else "")
    root = tmp_path / "source"
    root.mkdir()
    image = Image.new("RGB", (800, 400), (40, 120, 70))
    exif = Image.Exif()
    exif[274] = 6
    image.save(root / "canonical.jpg", exif=exif)
    Image.new("RGBA", (20, 10), (50, 160, 40, 100)).save(root / "small.png")
    database = root / "data.sqlite"
    con = sqlite3.connect(database)
    con.executescript("""
      CREATE TABLE plants(latin_name TEXT PRIMARY KEY, images_scraped_at TEXT, images_error TEXT);
      CREATE TABLE plant_images(plant TEXT,url TEXT,path TEXT,source TEXT);
      CREATE TABLE image_downloads(url TEXT PRIMARY KEY,path TEXT,status TEXT,sha256 TEXT,fetched_at TEXT);
    """)
    names = ["Abelia triflora", "Abies alba", "Missing photo"]
    con.executemany("INSERT INTO plants VALUES(?, '2026-10-18', NULL)", [(name,) for name in names])
    urls = ["https://example.test/shared.jpg", "https://example.test/same-bytes.jpg", "https://example.test/small.png"]
    for url, file in zip(urls, ["canonical.jpg", "canonical.jpg", "small.png"], strict=True):
        con.execute("INSERT INTO image_downloads VALUES(?,?,'ok',?,'2026-10-18T00:00:00Z')",
                    (url, file, hashlib.sha256((root / file).read_bytes()).hexdigest()))
    con.executemany("INSERT INTO plant_images VALUES(?,?,'legacy-wrong-file.jpg',?)", [
        (names[0], urls[0], "© Author [1], raw <credit>"), (names[1], urls[0], "Different credit for same URL"),
        (names[0], urls[1], None), (names[0], urls[2], ""),
    ])
    con.commit()
    con.close()
    catalog = tmp_path / "catalog"
    catalog.mkdir()
    index = [{"id": "pfaf:" + quote(name, safe=""), "scientificName": name} for name in names]
    descriptor = write_json_asset(catalog, "index.json", index)
    write_json_asset(catalog, "manifest.json", {"id": "b" * 20, "kind": "pfaf", "taxonCount": len(index),
                                               "sourceSha256": "c" * 64, "indexFile": "index.json", "files": [descriptor]})
    return {"root": root, "database": database, "catalog": catalog / "manifest.json",
            "output": tmp_path / "public/photos", "urls": urls, "names": names}


def test_all_associations_exact_credits_orientation_dedup_and_determinism(source: dict[str, Any]) -> None:
    original_db = source["database"].read_bytes()
    original_files = {path.name: path.read_bytes() for path in source["root"].iterdir()}
    path = photos.prepare_photos(source["database"], source["root"], source["catalog"], source["output"], COMMIT)
    manifest = json.loads(path.read_text())
    assert manifest["counts"] == {"photos": 3, "uniqueFiles": 2, "associations": 4, "plantsWithPhotos": 2,
                                   "plants": 3, "photoBytes": sum(file.stat().st_size for file in (path.parent / "files").iterdir()),
                                   "originalBytes": 2 * (source["root"] / "canonical.jpg").stat().st_size + (source["root"] / "small.png").stat().st_size}
    shared = hashlib.sha256(source["urls"][0].encode()).hexdigest()
    first = manifest["images"][shared]
    assert (first["width"], first["height"]) == (320, 640)  # EXIF orientation precedes bounding.
    small = manifest["images"][hashlib.sha256(source["urls"][2].encode()).hexdigest()]
    assert (small["width"], small["height"]) == (20, 10)  # Never upscale.
    assert manifest["plants"]["pfaf:Abies%20alba"] == [{"photoId": shared, "credit": "Different credit for same URL"}]
    assert {item["credit"] for item in manifest["plants"]["pfaf:Abelia%20triflora"]} == {None, "", "© Author [1], raw <credit>"}
    assert manifest["plants"]["pfaf:Missing%20photo"] == []
    for image in manifest["images"].values():
        data = (path.parent / image["url"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == image["sha256"]
        assert len(data) == image["bytes"]
        with Image.open(path.parent / image["url"]) as decoded:
            decoded.load()
            assert decoded.format == "WEBP"
            assert "exif" not in decoded.info and "icc_profile" not in decoded.info
    before = {str(file.relative_to(source["output"].parent)): file.read_bytes() for file in source["output"].parent.rglob("*") if file.is_file()}
    assert photos.prepare_photos(source["database"], source["root"], source["catalog"], source["output"], COMMIT) == path
    assert before == {str(file.relative_to(source["output"].parent)): file.read_bytes() for file in source["output"].parent.rglob("*") if file.is_file()}
    assert source["database"].read_bytes() == original_db
    assert original_files == {file.name: file.read_bytes() for file in source["root"].iterdir()}


def test_failed_refresh_is_not_reassigned_and_fuzzy_names_fail(source: dict[str, Any]) -> None:
    con = sqlite3.connect(source["database"])
    con.execute("UPDATE plants SET images_error='source unavailable' WHERE latin_name='Abies alba'")
    con.commit()
    con.close()
    path = photos.prepare_photos(source["database"], source["root"], source["catalog"], source["output"], COMMIT)
    manifest = json.loads(path.read_text())
    assert manifest["plants"]["pfaf:Abies%20alba"] == []
    assert manifest["source"]["plantChecks"]["pfaf:Abies%20alba"]["imagesError"] == "source unavailable"
    con = sqlite3.connect(source["database"])
    con.execute("UPDATE plant_images SET plant='Abelia TRIFLORA' WHERE plant='Abelia triflora'")
    con.execute("INSERT INTO plants VALUES('Abelia TRIFLORA','2026-10-18',NULL)")
    con.commit()
    con.close()
    previous = (source["output"].parent / "photos.json").read_bytes()
    with pytest.raises(ValueError, match="no fuzzy mapping"):
        photos.prepare_photos(source["database"], source["root"], source["catalog"], source["output"], COMMIT)
    assert (source["output"].parent / "photos.json").read_bytes() == previous


@pytest.mark.parametrize("failure", ["source-hash", "source-decode", "catalog-hash", "existing-output"])
def test_integrity_failures_preserve_previous_pointer(source: dict[str, Any], failure: str) -> None:
    path = photos.prepare_photos(source["database"], source["root"], source["catalog"], source["output"], COMMIT)
    previous = (source["output"].parent / "photos.json").read_bytes()
    if failure.startswith("source"):
        (source["root"] / "canonical.jpg").write_bytes(b"corrupt")
        if failure == "source-decode":
            con = sqlite3.connect(source["database"])
            con.execute("UPDATE image_downloads SET sha256=? WHERE path='canonical.jpg'", (hashlib.sha256(b"corrupt").hexdigest(),))
            con.commit()
            con.close()
    elif failure == "catalog-hash":
        (source["catalog"].parent / "index.json").write_text("[]")
    else:
        next((path.parent / "files").iterdir()).write_bytes(b"corrupt")
    with pytest.raises((ValueError, OSError)):
        photos.prepare_photos(source["database"], source["root"], source["catalog"], source["output"], COMMIT)
    assert (source["output"].parent / "photos.json").read_bytes() == previous
    assert not list(source["output"].glob(".photos-*"))
