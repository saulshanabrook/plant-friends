from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from tools.plant_assets.fixtures import validate_fixture_entries


def test_licensed_fixture_mapping_is_exactly_in_current_catalog() -> None:
    document = json.loads(Path("fixtures/photos.json").read_text())
    photos = document["photos"]
    validate_fixture_entries(photos)
    positive = [photo for photo in photos if photo["expectedTaxonId"] is not None]
    negative = [photo for photo in photos if photo["expectedTaxonId"] is None]
    assert len(photos) == 28
    assert len(positive) == document["evaluation"]["positiveCount"] == 24
    assert len(negative) == document["evaluation"]["negativeCount"] == 4
    assert len({photo["scientificName"] for photo in positive}) == 12
    # The added negatives must not alter any of the approved positive metadata.
    positive_hash = hashlib.sha256(json.dumps(positive, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert positive_hash == "5cfeeb2a1f06ca6afac88e6638846b26f663eeb92e10c0e6d019c6daea3bef1b"
    source = Path(__file__).resolve().parents[2].parent / "pfaf-data/data.sqlite"
    with source.open("rb") as file:
        source_hash = hashlib.file_digest(file, "sha256").hexdigest()
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as con:
        for photo in photos:
            count = con.execute("SELECT count(*) FROM plants WHERE trim(latin_name)=? COLLATE NOCASE", (photo["scientificName"],)).fetchone()[0]
            assert count == (1 if photo["expectedTaxonId"] is not None else 0)
            if photo["expectedTaxonId"] is None:
                assert photo["catalogAbsence"]["sourceSha256"] == source_hash
                assert photo["catalogAbsence"]["trimmedCaseInsensitiveSourceKeyCount"] == count
            assert photo["licenseUrl"].startswith("https://creativecommons.org/")
            assert photo["width"] > 0 and photo["height"] > 0
            assert photo["photoSourceUrl"] == f"https://www.inaturalist.org/photos/{photo['photoId']}"
    assert sum(photo["negativeKind"] == "out-of-catalog-plant" for photo in negative) == 2
    assert sum(photo["negativeKind"] == "non-plant" for photo in negative) == 2


@pytest.mark.parametrize("field,value,error", [
    ("file", "../outside.jpg", "basenames"),
    ("license", "cc-by-nc", "license"),
    ("expectedTaxonId", "pfaf:another-species", "manual resolution"),
    ("sha256", None, "hash"),
    ("sourceUrl", "https://example.org/photo", "source URL"),
])
def test_invalid_fixture_contracts_fail(field: str, value: Any, error: str) -> None:
    photo = json.loads(Path("fixtures/photos.json").read_text())["photos"][0]
    photo[field] = value
    with pytest.raises(ValueError, match=error):
        validate_fixture_entries([photo])


def test_repeated_observation_is_not_counted_as_distinct_evidence() -> None:
    photo = json.loads(Path("fixtures/photos.json").read_text())["photos"][0]
    duplicate = {**photo, "file": "other.jpg", "photoId": 999999}
    with pytest.raises(ValueError, match="distinct"):
        validate_fixture_entries([photo, duplicate])


def test_null_mapping_requires_explicit_negative_evidence() -> None:
    photo = json.loads(Path("fixtures/photos.json").read_text())["photos"][0]
    photo["expectedTaxonId"] = None
    with pytest.raises(ValueError, match="absence evidence"):
        validate_fixture_entries([photo])
    del photo["expectedTaxonId"]
    with pytest.raises(ValueError, match="explicitly"):
        validate_fixture_entries([photo])
