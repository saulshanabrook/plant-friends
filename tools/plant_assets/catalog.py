"""Export the current PFAF schema without running or modifying its scraper."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

EXPORT_VERSION = "pfaf-catalog-v1"


def write_json_asset(directory: Path, name: str, value: object) -> dict[str, Any]:
    """Serialize an asset deterministically and describe the exact bytes on disk."""
    data = (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode()
    # A killed writer must not leave a valid-looking partial manifest or pointer.
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, prefix=f".{name}.", delete=False) as file:
            temporary = Path(file.name)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, directory / name)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"url": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def export_catalog(database: Path, output: Path) -> Path:
    source_hash = hashlib.file_digest(database.open("rb"), "sha256").hexdigest()
    catalog_id = hashlib.sha256(f"{EXPORT_VERSION}:{source_hash}".encode()).hexdigest()[:20]
    directory = output / catalog_id
    directory.mkdir(parents=True, exist_ok=True)
    manifest_path = directory / "manifest.json"
    exported_at = datetime.now(timezone.utc).isoformat()
    if manifest_path.exists():
        exported_at = json.loads(manifest_path.read_text())["exportedAt"]

    con = sqlite3.connect(f"file:{quote(str(database.resolve()))}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        con.execute("BEGIN")
        plants = [dict(row) for row in con.execute("SELECT * FROM plants ORDER BY latin_name COLLATE BINARY")]
        associations: dict[str, list[dict[str, Any]]] = {}
        for row in con.execute("""
            SELECT p.plant, p.category, p.name, u.description
            FROM plant_uses p LEFT JOIN uses u USING(category,name)
            ORDER BY p.plant COLLATE BINARY,p.category COLLATE BINARY,p.name COLLATE BINARY
        """):
            associations.setdefault(row["plant"], []).append({
                "category": row["category"], "name": row["name"], "description": row["description"]
            })
    finally:
        con.close()

    labels: dict[str, str] = {}
    ids: set[str] = set()
    records: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    for plant in plants:
        name = plant.get("latin_name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Every source record needs a non-empty latin_name")
        label = name.strip()
        if label.casefold() in labels:
            raise ValueError(f"Duplicate model label: {name!r} and {labels[label.casefold()]!r}")
        labels[label.casefold()] = name
        taxon_id = "pfaf:" + quote(name, safe="")
        if taxon_id in ids:
            raise ValueError(f"Duplicate source ID: {name!r}")
        ids.add(taxon_id)
        for field in ("edibility_rating", "medicinal_rating", "other_uses_rating"):
            value = plant.get(field)
            if value is not None and (not isinstance(value, (int, float)) or not 0 <= value <= 5):
                raise ValueError(f"Invalid {field} for {name}: {value!r}")
        if any(char in name for char in "'()×"):
            warnings.append({"sourceKey": name, "reason": "Cultivar, hybrid, or parenthetical name preserved verbatim"})
        records.append({"id": taxon_id, "sourceKey": name, "fields": plant, "uses": associations.pop(name, [])})
    if associations:
        raise ValueError(f"Use associations reference absent plants: {list(associations)[:5]}")
    if not records:
        raise ValueError("The catalog is empty")

    index: list[dict[str, str]] = []
    files: list[dict[str, Any]] = []
    for start in range(0, len(records), 256):
        filename = f"details-{start // 256:03d}.json"
        chunk = records[start:start + 256]
        files.append(write_json_asset(directory, filename, {r["id"]: r for r in chunk}))
        index.extend({
            "id": r["id"], "scientificName": r["sourceKey"],
            "commonName": r["fields"]["common_name"], "detailFile": filename
        } for r in chunk)
    files.insert(0, write_json_asset(directory, "index.json", index))
    final_source_hash = hashlib.file_digest(database.open("rb"), "sha256").hexdigest()
    if source_hash != final_source_hash:
        raise ValueError("Source database changed during export; retry against a stable snapshot")
    manifest = {
        "schemaVersion": 1, "kind": "pfaf", "id": catalog_id,
        "name": "Plants For A Future", "taxonCount": len(index),
        "sourceSha256": source_hash, "exportVersion": EXPORT_VERSION, "exportedAt": exported_at,
        "attribution": "Plants For A Future (PFAF); unofficial snapshot from saulshanabrook/pfaf-data",
        "sourceUrl": "https://github.com/saulshanabrook/pfaf-data",
        "termsUrl": "https://pfaf.org/user/cmspage.aspx?pageid=136",
        "files": files, "indexFile": "index.json", "warnings": warnings,
    }
    write_json_asset(directory, "manifest.json", manifest)
    # The root pointer is small and can be updated independently of immutable pack URLs.
    output.parent.parent.mkdir(parents=True, exist_ok=True)
    pointer = {"url": f"packs/pfaf/{catalog_id}/manifest.json"}
    write_json_asset(output.parent.parent, "catalog.json", pointer)
    return manifest_path
