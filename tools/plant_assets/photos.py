"""Prepare a supplemental reference-photo pack from verified local PFAF files."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlsplit

from PIL import Image, ImageOps, __version__ as pillow_version, features

from .catalog import write_json_asset

POLICY = {
    "version": "pfaf-photos-webp-v1", "orientation": "EXIF transpose once",
    "resize": "longest edge at most 640; no upscale; Pillow LANCZOS",
    "format": "WebP", "quality": 75, "method": 4,
    "alpha": "preserve transparency", "metadata": "omit EXIF and ICC; no color-profile conversion",
}


def prepare_photos(database: Path, source_root: Path, catalog_path: Path, output: Path,
                   expected_commit: str, progress: Callable[[int, int], None] | None = None) -> Path:
    """Verify source ownership, derive bounded images, then atomically publish a pointer."""
    if len(expected_commit) != 40 or any(char not in "0123456789abcdef" for char in expected_commit):
        raise ValueError("Expected a complete immutable source commit")
    source_root = source_root.resolve()
    commit = subprocess.check_output(["git", "-C", str(source_root), "rev-parse", "HEAD"], text=True).strip()
    if commit != expected_commit:
        raise ValueError("The image source checkout is not at the expected commit")
    if subprocess.check_output(["git", "-C", str(source_root), "status", "--porcelain", "--untracked-files=no"], text=True).strip():
        raise ValueError("The image source checkout has tracked changes; preserve it and use a verified snapshot")
    with database.open("rb") as stream:
        source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    catalog = json.loads(catalog_path.read_text())
    index_bytes = (catalog_path.parent / catalog["indexFile"]).read_bytes()
    descriptor = next(file for file in catalog["files"] if file["url"] == catalog["indexFile"])
    if len(index_bytes) != descriptor["bytes"] or hashlib.sha256(index_bytes).hexdigest() != descriptor["sha256"]:
        raise ValueError("Catalog index integrity failed")
    index = json.loads(index_bytes)
    names = {entry["scientificName"]: entry["id"] for entry in index}
    if catalog["kind"] != "pfaf" or len(names) != len(index) or len(index) != catalog["taxonCount"] or any(
            entry["id"] != "pfaf:" + quote(entry["scientificName"], safe="") for entry in index):
        raise ValueError("The existing catalog must have exact, unique source keys and IDs")
    con = sqlite3.connect(f"file:{quote(str(database.resolve()))}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        con.execute("BEGIN")
        checks = {row["latin_name"]: dict(row) for row in con.execute(
            "SELECT latin_name,images_scraped_at,images_error FROM plants ORDER BY latin_name COLLATE BINARY")}
        rows = [dict(row) for row in con.execute("""
            SELECT i.plant,i.url,i.source,d.path,d.sha256,d.fetched_at
            FROM plant_images i JOIN image_downloads d ON d.url=i.url JOIN plants p ON p.latin_name=i.plant
            WHERE d.status='ok' AND p.images_scraped_at IS NOT NULL AND p.images_error IS NULL
            ORDER BY i.plant COLLATE BINARY,i.url COLLATE BINARY
        """)]
    finally:
        con.close()
    if any(name not in checks for name in names) or any(row["plant"] not in names for row in rows):
        raise ValueError("Photo source keys do not exactly match the existing catalog; no fuzzy mapping is allowed")
    output.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".photos-", dir=output))
    try:
        (staging / "files").mkdir()
        plants: dict[str, list[dict[str, Any]]] = {entry["id"]: [] for entry in index}
        images: dict[str, dict[str, Any]] = {}
        by_original: dict[str, dict[str, Any]] = {}
        unique = {row["url"]: row for row in rows}
        physical: dict[str, int] = {}
        original_bytes = 0
        for position, (url, row) in enumerate(sorted(unique.items()), 1):
            parsed = urlsplit(url)
            if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
                raise ValueError("A source photograph URL is invalid")
            path = (source_root / row["path"]).resolve()
            if not path.is_relative_to(source_root) or not path.is_file():
                raise ValueError(f"Verified source photograph is missing or escaped its checkout: {row['path']}")
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest != row["sha256"]:
                raise ValueError(f"Original photograph SHA-256 failed: {url}")
            original_bytes += len(data)
            derived = by_original.get(digest)
            if derived is None:
                with Image.open(io.BytesIO(data)) as original:
                    original.load()  # Decode the complete source before deriving anything.
                    if getattr(original, "n_frames", 1) != 1:
                        raise ValueError("Animated source images need an explicit preservation policy")
                    image = ImageOps.exif_transpose(original)
                    image = image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")
                    image.thumbnail((640, 640), Image.Resampling.LANCZOS)
                    encoded = io.BytesIO()
                    image.save(encoded, format="WEBP", quality=75, method=4)
                    body = encoded.getvalue()
                    if len(body) > 4 * 1024 * 1024:
                        raise ValueError("A derived photograph exceeded its bounded size")
                    with Image.open(io.BytesIO(body)) as verified:
                        verified.load()
                        if verified.format != "WEBP" or verified.size != image.size or not all(1 <= side <= 640 for side in verified.size):
                            raise ValueError("A derived photograph failed full decode/shape validation")
                    derived_hash = hashlib.sha256(body).hexdigest()
                    filename = f"files/{derived_hash}.webp"
                    if derived_hash not in physical:
                        (staging / filename).write_bytes(body)
                        physical[derived_hash] = len(body)
                    derived = {"url": filename, "sha256": derived_hash, "bytes": len(body), "width": image.width,
                               "height": image.height, "originalWidth": original.width, "originalHeight": original.height,
                               "originalFormat": original.format}
                    by_original[digest] = derived
            photo_id = hashlib.sha256(url.encode()).hexdigest()
            images[photo_id] = {**derived, "originalUrl": url, "originalSha256": digest,
                                "freshness": {"fetchedAt": row["fetched_at"]}}
            if progress and (position % 500 == 0 or position == len(unique)):
                progress(position, len(unique))
        for row in rows:
            if row["source"] is not None and not isinstance(row["source"], str):
                raise ValueError("A photo credit is not recorded text or null")
            plants[names[row["plant"]]].append({"photoId": hashlib.sha256(row["url"].encode()).hexdigest(), "credit": row["source"]})
        manifest: dict[str, Any] = {
            "schemaVersion": 1, "catalogId": catalog["id"],
            "source": {"repository": "https://github.com/saulshanabrook/pfaf-data", "commit": commit,
                       "databaseSha256": source_hash, "catalogSourceSha256": catalog["sourceSha256"],
                       "attribution": "Plants For A Future (PFAF); original photo credits retained per plant association",
                       "termsUrl": "https://pfaf.org/user/cmspage.aspx?pageid=136", "transform": POLICY,
                       "versions": {"Pillow": pillow_version, "libwebp": features.version("webp")},
                       "plantChecks": {taxon_id: {"sourceKey": name, "imagesScrapedAt": checks[name]["images_scraped_at"],
                                                  "imagesError": checks[name]["images_error"]} for name, taxon_id in names.items()}},
            "images": images, "plants": plants,
            "counts": {"photos": len(images), "uniqueFiles": len(physical), "associations": len(rows),
                       "plantsWithPhotos": sum(bool(value) for value in plants.values()), "plants": len(index),
                       "photoBytes": sum(physical.values()), "originalBytes": original_bytes},
        }
        identity = hashlib.sha256(json.dumps(manifest, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:20]
        manifest = {"schemaVersion": 1, "id": identity, **manifest}
        receipt = write_json_asset(staging, "manifest.json", manifest)
        if receipt["bytes"] > 32 * 1024 * 1024:
            raise ValueError("The photo manifest exceeds its browser metadata limit")
        with database.open("rb") as stream:
            final_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        if final_hash != source_hash or subprocess.check_output(["git", "-C", str(source_root), "rev-parse", "HEAD"], text=True).strip() != commit:
            raise ValueError("The source snapshot changed during photo preparation")
        destination = output / identity
        if destination.exists():
            for file in staging.rglob("*"):
                if file.is_file() and (not (destination / file.relative_to(staging)).is_file() or
                                     (destination / file.relative_to(staging)).read_bytes() != file.read_bytes()):
                    raise ValueError("An existing photo pack is corrupted; preserve it and rebuild explicitly")
        else:
            os.replace(staging, destination)
        write_json_asset(output.parent, "photos.json", {**receipt, "url": f"photos/{identity}/manifest.json"})
        return destination / "manifest.json"
    finally:
        if staging.exists():
            shutil.rmtree(staging)
