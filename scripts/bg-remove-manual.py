#!/usr/bin/env python3
"""Background-only removal for manually-cropped pet images.

Use this when a sheet's automatic slicer (`build-pets-cats.py`) chops part
of the character — Persian's label band forces a top strip aggressive enough
to clip the ears. Workaround: crop the cells by hand, drop them into
`pet/<breed>_manual/`, run this script.

Input  : pet/<breed>_manual/<state>.png   (e.g. persian_manual/typing.png)
Output : code-crew/src/assets/pets/<breed>_<state>.png

Only flood-fills the lavender/white surround. No top/bottom strips, no rim
erosion, no largest-component selection — those would risk eating into the
character. The pipeline trusts the manual crop.
"""
from __future__ import annotations
import argparse
from pathlib import Path
from PIL import Image, ImageDraw

STATES = ("sleeping", "typing", "surprised", "disappointed", "relieved")

# Threshold for the corner flood. Wide enough to catch the page lavender
# (~217, 204, 250) and the pill-body lavender (~235, 225, 252) as one
# contiguous fill, narrow enough to stop at the character's outline.
CORNER_THRESH = 30

# Shallow inset seeds for any pill-body pocket the corner flood missed
# (e.g. when the corner sits inside a rounded-rim cell and the lavender
# only exists in the centre). Threshold matches Pass 2 of build-pets-cats.
INSET_PX = 40
INSET_THRESH = 35


def remove_bg(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA").copy()
    w, h = img.size

    for cx, cy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if img.getpixel((cx, cy))[3] > 0:
            ImageDraw.floodfill(img, (cx, cy), (0, 0, 0, 0), thresh=CORNER_THRESH)

    seeds = [
        (INSET_PX, INSET_PX),
        (w - INSET_PX, INSET_PX),
        (INSET_PX, h - INSET_PX),
        (w - INSET_PX, h - INSET_PX),
    ]
    for sx, sy in seeds:
        if 0 <= sx < w and 0 <= sy < h and img.getpixel((sx, sy))[3] > 0:
            ImageDraw.floodfill(img, (sx, sy), (0, 0, 0, 0), thresh=INSET_THRESH)

    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--breed", required=True, help="breed id, e.g. 'persian'")
    p.add_argument(
        "--input-dir",
        default=None,
        help="defaults to ~/clawd-work/pet/<breed>_manual",
    )
    p.add_argument(
        "--output-dir",
        default=str(Path(__file__).parent.parent / "src" / "assets" / "pets"),
    )
    args = p.parse_args()

    input_dir = Path(args.input_dir) if args.input_dir else (
        Path.home() / "clawd-work" / "pet" / f"{args.breed}_manual"
    )
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_dir.exists():
        raise SystemExit(f"input dir not found: {input_dir}")

    for state in STATES:
        src = input_dir / f"{state}.png"
        if not src.exists():
            print(f"SKIP {state}: missing {src.name}")
            continue
        out = output_dir / f"{args.breed}_{state}.png"
        result = remove_bg(Image.open(src))
        result.save(out, "PNG")
        print(f"wrote {out.name}  size={result.size}")


if __name__ == "__main__":
    main()
