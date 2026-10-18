"""Bounded, attributed iNaturalist photo fixtures; never used by the product UI."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image

from .catalog import write_json_asset

SPECIES = ["Trifolium repens", "Plantago major", "Bellis perennis", "Alliaria petiolata",
           "Achillea millefolium", "Sambucus nigra", "Calendula officinalis", "Salvia officinalis",
           "Rubus idaeus", "Malus domestica", "Moringa oleifera", "Urtica dioica"]
LICENSE_URLS = {"cc0": "https://creativecommons.org/publicdomain/zero/1.0/",
                "cc-by": "https://creativecommons.org/licenses/by/4.0/"}


def validate_fixture_entries(entries: list[dict[str, Any]], require_hashes: bool = True) -> None:
    """Reject unsafe paths, unsupported licenses, duplicate observations, and invented mappings."""
    if not entries:
        raise ValueError("No licensed exact-name fixture observations were found")
    photos: set[int] = set()
    observations: set[int] = set()
    files: set[str] = set()
    for entry in entries:
        filename = entry.get("file")
        if not isinstance(filename, str) or not filename or Path(filename).name != filename or filename in files:
            raise ValueError("Fixture filenames must be unique local basenames")
        files.add(filename)
        photo_id = entry.get("photoId")
        observation_id = entry.get("observationId")
        if (not isinstance(photo_id, int) or photo_id <= 0 or photo_id in photos or
                not isinstance(observation_id, int) or observation_id <= 0 or observation_id in observations):
            raise ValueError("Fixture photos must come from distinct identified observations")
        photos.add(photo_id)
        observations.add(observation_id)
        if not isinstance(entry.get("taxonId"), int) or entry["taxonId"] <= 0:
            raise ValueError("Fixture taxon identifiers must identify a recorded iNaturalist taxon")
        if entry.get("license") not in LICENSE_URLS or not all(isinstance(entry.get(field), str) and entry[field].strip()
                                                              for field in ("author", "attribution", "scientificName")):
            raise ValueError("Fixture license and attribution are required")
        name = entry["scientificName"]
        if "expectedTaxonId" not in entry:
            raise ValueError("Fixture mappings must explicitly provide a PFAF ID or null")
        expected = entry.get("expectedTaxonId")
        if expected is not None and expected != "pfaf:" + urllib.parse.quote(name, safe=""):
            raise ValueError("Non-exact taxon mappings need explicit manual resolution before use")
        if expected is None:
            kind = entry.get("negativeKind")
            absence = entry.get("catalogAbsence")
            if (kind not in ("out-of-catalog-plant", "non-plant") or not isinstance(absence, dict) or
                    absence.get("trimmedCaseInsensitiveSourceKeyCount") != 0 or
                    not isinstance(absence.get("sourceSha256"), str) or
                    not re.fullmatch(r"[a-f0-9]{64}", absence["sourceSha256"])):
                raise ValueError("Negative fixtures need an explicit category and catalog absence evidence")
            iconic_taxon = entry.get("iconicTaxon")
            if (not isinstance(iconic_taxon, str) or not iconic_taxon or
                    (kind == "out-of-catalog-plant") != (iconic_taxon == "Plantae")):
                raise ValueError("Negative fixture category conflicts with its recorded iNaturalist taxon group")
        source_url = f"https://www.inaturalist.org/observations/{observation_id}"
        if entry.get("sourceUrl") != source_url:
            raise ValueError("Fixture source URL must identify its recorded observation")
        url = urllib.parse.urlsplit(entry.get("downloadUrl", ""))
        if url.scheme != "https" or not url.hostname or url.username or url.password:
            raise ValueError("Fixture downloads require an attributed HTTPS source")
        digest = entry.get("sha256")
        if require_hashes and (not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
            raise ValueError("Existing fixture manifests must pin every photo hash")


def fetch_fixtures(manifest: Path, discover: bool = False) -> None:
    destination = Path("public/fixtures/photos")
    entries: list[dict[str, Any]] = []
    if manifest.exists():
        document = json.loads(manifest.read_text(encoding="utf-8"))
        entries = document["photos"]
        validate_fixture_entries(entries)
    elif discover:
        for name in SPECIES:
            query = urllib.parse.urlencode({"taxon_name": name, "quality_grade": "research",
                                            "photo_license": "cc0,cc-by", "per_page": 30,
                                            "order_by": "id", "order": "asc"})
            request = urllib.request.Request("https://api.inaturalist.org/v1/observations?" + query,
                                             headers={"User-Agent": "PlantFriends-local-evaluation/0.1"})
            with urllib.request.urlopen(request, timeout=40) as response:
                data = json.load(response)
            selected = 0
            for observation in data["results"]:
                # Name queries can include descendants or recently split taxa.
                if observation["taxon"]["name"] != name:
                    continue
                photo = next((p for p in observation["photos"] if p.get("license_code") in LICENSE_URLS and not p.get("hidden")), None)
                if not photo:
                    continue
                entries.append({
                    "file": f"inat-{photo['id']}.jpg", "scientificName": name,
                    "expectedTaxonId": "pfaf:" + urllib.parse.quote(name, safe=""),
                    "observationId": observation["id"], "taxonId": observation["taxon"]["id"],
                    "photoId": photo["id"], "license": photo["license_code"],
                    "author": observation["user"]["login"], "attribution": photo["attribution"],
                    "sourceUrl": f"https://www.inaturalist.org/observations/{observation['id']}",
                    "downloadUrl": photo["url"].replace("/square.", "/medium."),
                })
                selected += 1
                if selected == 2:
                    break
            print(f"{name}: {selected} licensed observations", flush=True)
            time.sleep(1.1)
        document = {"source": "iNaturalist", "limitations": "Small descriptive sample; may overlap model pretraining", "photos": entries}
        validate_fixture_entries(entries, require_hashes=False)
    else:
        raise ValueError("Fixture manifest not found; use --discover once to select licensed public observations")
    destination.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        target = destination / entry["file"]
        if not target.exists():
            request = urllib.request.Request(entry["downloadUrl"], headers={"User-Agent": "PlantFriends-local-evaluation/0.1"})
            with urllib.request.urlopen(request, timeout=40) as response:
                data_bytes = response.read(20 * 1024 * 1024 + 1)
            if len(data_bytes) > 20 * 1024 * 1024:
                raise ValueError(f"Remote fixture exceeds the 20 MiB photo limit: {entry['file']}")
            if entry.get("sha256") and hashlib.sha256(data_bytes).hexdigest() != entry["sha256"]:
                raise ValueError(f"Remote fixture changed: {entry['file']}")
            with Image.open(io.BytesIO(data_bytes)) as image:
                image.verify()
            temporary = target.with_suffix(".tmp")
            try:
                temporary.write_bytes(data_bytes)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            time.sleep(1.1)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if entry.get("sha256") and entry["sha256"] != digest:
            raise ValueError(f"Fixture integrity failed: {target}")
        entry["sha256"] = digest
        entry["licenseUrl"] = LICENSE_URLS[entry["license"]]
        entry["photoSourceUrl"] = f"https://www.inaturalist.org/photos/{entry['photoId']}"
        entry["changes"] = "Unmodified downloaded medium image; evaluation preprocessing is recorded separately"
        entry["mappingBasis"] = ("Exact iNaturalist taxon scientific name equals the preserved PFAF source key"
                                 if entry.get("expectedTaxonId") is not None else
                                 "No PFAF source record expected; excluded from positive classification totals")
        with Image.open(target) as image:
            entry["width"], entry["height"] = image.size
    validate_fixture_entries(entries)
    document["schemaVersion"] = 1
    document["evaluation"] = {
        "positiveCount": sum(entry["expectedTaxonId"] is not None for entry in entries),
        "negativeCount": sum(entry["expectedTaxonId"] is None for entry in entries),
        "negativePolicy": "Exclude null expectedTaxonId from positive top-one/top-five totals; record raw possible matches without assuming rejection",
    }
    manifest.parent.mkdir(parents=True, exist_ok=True)
    write_json_asset(manifest.parent, manifest.name, document)
    write_json_asset(destination.parent, "photos.json", document)
    print(f"Ready: {len(entries)} pinned photo fixtures", flush=True)
