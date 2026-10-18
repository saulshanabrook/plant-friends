"""Render the plain PF app icons. Requires Pillow; no generated artwork or font download."""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--font", type=Path, default=Path("/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"))
args = parser.parse_args()
output = Path(__file__).resolve().parents[1] / "public"
output.joinpath("icon.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
    '<rect width="512" height="512" fill="white"/>'
    '<text x="256" y="256" text-anchor="middle" dominant-baseline="central" '
    'font-family="Times New Roman,serif" font-weight="bold" font-size="248" fill="black">PF</text>'
    '</svg>\n'
)
for size in (192, 512):
    image = Image.new("RGB", (size * 3, size * 3), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(args.font), round(size * 3 * 248 / 512))
    bounds = draw.textbbox((0, 0), "PF", font=font)
    draw.text(((image.width - bounds[2] - bounds[0]) / 2, (image.height - bounds[3] - bounds[1]) / 2), "PF", font=font, fill="black")
    image.resize((size, size), Image.Resampling.LANCZOS).save(output / f"icon-{size}.png")
