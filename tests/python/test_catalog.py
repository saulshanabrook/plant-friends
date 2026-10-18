from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from tools.plant_assets.catalog import export_catalog, write_json_asset

SOURCE = Path(__file__).resolve().parents[2].parent / "pfaf-data" / "data.sqlite"


@pytest.fixture(scope="module")
def exported(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return export_catalog(SOURCE, tmp_path_factory.mktemp("catalog") / "public/packs/pfaf")


def test_all_source_fields_and_use_associations_round_trip(exported: Path) -> None:
    manifest = json.loads(exported.read_text())
    index = json.loads((exported.parent / manifest["indexFile"]).read_text())
    details: dict[str, Any] = {}
    for filename in {entry["detailFile"] for entry in index}:
        details.update(json.loads((exported.parent / filename).read_text()))
    con = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    plants = {r["latin_name"]: dict(r) for r in con.execute("SELECT * FROM plants")}
    assert len(details) == manifest["taxonCount"] == len(plants)
    assert len({entry["id"] for entry in index}) == len(plants)
    missing = 0
    use_count = 0
    for item in index:
        record = details[item["id"]]
        assert record["sourceKey"] == item["scientificName"]
        assert record["fields"] == plants[item["scientificName"]]
        assert item["commonName"] == record["fields"]["common_name"]
        expected = [dict(row) for row in con.execute("""
            SELECT p.category,p.name,u.description FROM plant_uses p
            LEFT JOIN uses u USING(category,name) WHERE p.plant=?
            ORDER BY p.category COLLATE BINARY,p.name COLLATE BINARY
        """, (record["sourceKey"],))]
        assert record["uses"] == expected
        use_count += len(record["uses"])
        missing += not bool(record["fields"]["physical_characteristics"])
    assert missing == con.execute("SELECT count(*) FROM plants WHERE coalesce(physical_characteristics,'')='' ").fetchone()[0]
    assert use_count == con.execute("SELECT count(*) FROM plant_uses").fetchone()[0]
    con.close()


def test_assets_are_hashed_and_export_preserves_source(exported: Path) -> None:
    manifest = json.loads(exported.read_text())
    assert manifest["sourceSha256"] == hashlib.file_digest(SOURCE.open("rb"), "sha256").hexdigest()
    for asset in manifest["files"]:
        data = (exported.parent / asset["url"]).read_bytes()
        assert len(data) == asset["bytes"]
        assert hashlib.sha256(data).hexdigest() == asset["sha256"]
    before = {file.name: file.read_bytes() for file in exported.parent.iterdir()}
    assert export_catalog(SOURCE, exported.parent.parent) == exported
    assert before == {file.name: file.read_bytes() for file in exported.parent.iterdir()}


def test_missing_information_and_reference_markers_are_not_rewritten(exported: Path) -> None:
    index = json.loads((exported.parent / "index.json").read_text())
    abelia = next(entry for entry in index if entry["scientificName"] == "Abelia triflora")
    record = json.loads((exported.parent / abelia["detailFile"]).read_text())[abelia["id"]]
    assert record["fields"]["edibility_rating"] == 0
    assert "[" in record["fields"]["other_uses"]
    assert record["fields"]["source_url"].startswith("https://pfaf.org/")
    unknown = next(entry for entry in index if entry["scientificName"] == "Agave chrysantha")
    record = json.loads((exported.parent / unknown["detailFile"]).read_text())[unknown["id"]]
    assert record["fields"]["details_scraped_at"] is None
    assert not record["fields"]["physical_characteristics"]


@pytest.mark.parametrize("names", [[""], ["Abelia triflora", " abelia TRIFLORA "]])
def test_empty_or_duplicate_model_labels_fail(tmp_path: Path, names: list[str]) -> None:
    source = tmp_path / "bad.sqlite"
    con = sqlite3.connect(source)
    con.executescript("""
        CREATE TABLE plants(latin_name TEXT,common_name TEXT);
        CREATE TABLE plant_uses(plant TEXT,category TEXT,name TEXT);
        CREATE TABLE uses(category TEXT,name TEXT,description TEXT);
    """)
    con.executemany("INSERT INTO plants VALUES(?, '')", [(name,) for name in names])
    con.commit()
    con.close()
    with pytest.raises(ValueError, match="non-empty|Duplicate model label"):
        export_catalog(source, tmp_path / "public/packs/pfaf")


def test_interrupted_json_publication_preserves_previous_pointer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_json_asset(tmp_path, "model.json", {"url": "previous/manifest.json"})
    original = (tmp_path / "model.json").read_bytes()

    def interrupted(source: object, destination: object) -> None:
        raise OSError("simulated publication interruption")

    monkeypatch.setattr(os, "replace", interrupted)
    with pytest.raises(OSError, match="interruption"):
        write_json_asset(tmp_path, "model.json", {"url": "new/manifest.json"})
    assert (tmp_path / "model.json").read_bytes() == original
    assert list(tmp_path.iterdir()) == [tmp_path / "model.json"]
