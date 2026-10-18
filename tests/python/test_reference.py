from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import open_clip
import pytest
from PIL import Image, ImageOps

from tools.plant_assets.reference import canonical_image, compare_embeddings, licensed_photo_sample


def test_alpha_composites_before_resize_and_discards_metadata(tmp_path: Path) -> None:
    image = Image.new("RGBA", (3, 2), (31, 149, 79, 127))
    source = tmp_path / "transparent.png"
    image.save(source, icc_profile=b"ignored-source-profile")
    actual = canonical_image(source)
    assert actual.mode == "RGB"
    assert actual.getpixel((0, 0)) == (143, 202, 167)
    assert actual.info == {}


def test_palette_and_luminance_alpha_follow_same_background_policy(tmp_path: Path) -> None:
    image = Image.new("P", (2, 1), 0)
    image.putpalette([0, 0, 0, 255, 0, 0] + [0] * 762)
    image.putpixel((1, 0), 1)
    image.save(tmp_path / "palette.png", transparency=0)
    assert np.asarray(canonical_image(tmp_path / "palette.png")).tolist() == [[[255, 255, 255], [255, 0, 0]]]
    Image.new("LA", (1, 1), (15, 0)).save(tmp_path / "la.png")
    assert canonical_image(tmp_path / "la.png").getpixel((0, 0)) == (255, 255, 255)


def test_exif_orientation_is_applied_exactly_once(tmp_path: Path) -> None:
    rgb = np.arange(2 * 3 * 3, dtype=np.uint8).reshape(2, 3, 3)
    image = Image.fromarray(rgb)
    exif = image.getexif()
    exif[274] = 6
    source = tmp_path / "oriented.png"
    image.save(source, exif=exif)
    actual = canonical_image(source)
    np.testing.assert_array_equal(np.asarray(actual), np.rot90(rgb, k=3))
    assert actual.size == (2, 3)
    np.testing.assert_array_equal(np.asarray(ImageOps.exif_transpose(actual)), np.asarray(actual))


def test_pinned_openclip_resize_matches_independent_pillow_golden(tmp_path: Path) -> None:
    golden = json.loads(Path("fixtures/numerical/resize-golden.json").read_text())
    transform = open_clip.transform.image_transform(224, is_train=False, interpolation="bicubic", resize_mode="shortest")
    for case in golden["cases"]:
        width, height = case["width"], case["height"]
        y, x, c = np.indices((height, width, 3))
        pixels = ((x * 13 + y * 7 + c * 59 + x * y % 113) % 256).astype(np.uint8)
        # Exercise the actual OpenCLIP evaluation resize and crop before ToTensor.
        actual = transform.transforms[1](transform.transforms[0](Image.fromarray(pixels)))
        assert hashlib.sha256(np.asarray(actual).tobytes()).hexdigest() == case["rgbSha256"]
        if width == 640 and height == 480:
            source = tmp_path / "landscape.webp"
            Image.fromarray(pixels).save(source, format="WEBP", lossless=True, exact=True, method=6)
            decoded = canonical_image(source)
            np.testing.assert_array_equal(np.asarray(decoded), pixels)
            transformed_webp = transform.transforms[1](transform.transforms[0](decoded))
            assert hashlib.sha256(np.asarray(transformed_webp).tobytes()).hexdigest() == case["rgbSha256"]


def test_embedding_comparison_checks_direction_and_rejects_zero_or_nonfinite() -> None:
    expected = np.zeros(768, dtype=np.float32)
    expected[0] = 1
    assert compare_embeddings(expected, expected * 3) == {"cosine": 1.0, "maxNormalizedEmbeddingError": 0.0}
    with pytest.raises(ValueError, match="nonzero"):
        compare_embeddings(expected, np.zeros(768, dtype=np.float32))
    with pytest.raises(ValueError, match="finite"):
        compare_embeddings(expected, np.full(768, np.nan, dtype=np.float32))


def test_additional_licensed_sample_uses_existing_integrity_and_metadata_contract(tmp_path: Path) -> None:
    directory = tmp_path / "reference"
    photos = tmp_path / "photos"
    photos.mkdir()
    source = photos / "licensed.png"
    Image.new("RGB", (3, 2), (17, 83, 129)).save(source)
    photo = {"file": source.name, "photoId": 28117, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
    assert licensed_photo_sample(photo, directory) == {"id": "28117", "photoUrl": "../photos/licensed.png"}
    source.write_bytes(b"changed photograph")
    with pytest.raises(ValueError, match="Fixture integrity failed"):
        licensed_photo_sample(photo, directory)
