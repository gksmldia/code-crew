#!/usr/bin/env python3
"""Slice the reference sprite sheet into per-breed × per-state PNGs.

The source sheet is 2752 × 1536, a 6-column × 10-row grid:
  col 0: BREED column — face icon (left third) + breed label (rest).
         We crop only the face-icon portion for use as picker thumbnails.
  col 1..5: SLEEPING / TYPING / SURPRISED / DISAPPOINTED / RELIEVED

Geometry, measured from the source:
  - Purple header band: y=0..107
  - First pill row begins around y=120
  - Last pill row ends around y=1530
  - 10 rows fit evenly in that span (~141 px per row)
  - 6 columns split the full width evenly (~458.67 px per column)

Each pill has its own pastel background (a different color than the page
gaps between pills). To erase it cleanly, we crop each cell with a generous
inset so that the corners of the crop land inside the pill body — that way
flood-filling from the corners erases the pill background in one pass.
"""
from __future__ import annotations
import argparse
from pathlib import Path
from PIL import Image, ImageDraw

BREEDS = [
    "golden_retriever",
    "shiba_inu",
    "beagle",
    "yorkshire_terrier",
    "pomeranian",
    "border_collie",
    "welsh_corgi",
    "dalmatian",
    "siberian_husky",
    "french_bulldog",
]
STATES = ["sleeping", "typing", "surprised", "disappointed", "relieved"]

# Vertical: rows are NOT evenly spaced. Measured by scanning the page-cream
# gaps between pills. ROW_BOUNDS[i] gives the y-coordinates [top, bottom] for
# breed row i, chosen at the center of each cream gap so the top/bottom corners
# of every crop land squarely in the cream — perfect seeds for flood-fill.
ROW_BOUNDS = [
    (119, 270),   # 0  golden_retriever
    (270, 415),   # 1  shiba_inu
    (415, 557),   # 2  beagle
    (557, 699),   # 3  yorkshire_terrier
    (699, 840),   # 4  pomeranian
    (840, 980),   # 5  border_collie
    (980, 1119),  # 6  welsh_corgi
    (1119, 1257), # 7  dalmatian
    (1257, 1395), # 8  siberian_husky
    (1395, 1527), # 9  french_bulldog
]

# 6 columns evenly span the full width.
SHEET_WIDTH = 2752
COLS = 6
COL_W = SHEET_WIDTH / COLS  # 458.67

# Per-cell inset (px) on x only. With ROW_BOUNDS already aligned to gap centers,
# corners are in cream — no vertical inset needed.
INSET_X = 25

# For column 0 (breed face icon), the icon occupies roughly the left third of
# the cell; the rest is the breed-name text. Crop a tight x-range around the
# icon and discard the rest.
ICON_X0 = 30   # left offset within column 0
ICON_X1 = 200  # right offset within column 0 (exclusive)



def is_rim_like(r: int, g: int, b: int) -> bool:
    # Light, desaturated pastel — covers warm rims (coral, peach) and cool
    # rims (lavender, mint). Excludes dark character outlines (min < 90) and
    # saturated character features (max-min ≥ 115). Pomeranian-style fluffy
    # white fur also matches; we rely on spatial constraints (border margin)
    # and component-size filtering to distinguish fur from rim.
    return min(r, g, b) > 90 and (max(r, g, b) - min(r, g, b)) < 115


# Distance from the cell border within which the rim-erosion pass is allowed
# to operate. Wide enough to reach the rim's innermost curve at rounded
# corners, narrow enough to leave the character body (and any fluffy fur near
# the head) untouched.
BORDER_MARGIN = 20

# Connected rim-like blobs smaller than this many pixels and entirely within
# the top or bottom edge band of the cell are stray "trapped" pill-body
# regions enclosed by the character's outline (e.g. the strip between a dog's
# ears) — erase them. Eye whites and other small rim-like features in the
# vertical middle of the cell are protected.
TRAPPED_BLOB_MAX = 1500
TRAPPED_EDGE_BAND = 40


def cell_to_transparent_state(cell: Image.Image) -> Image.Image:
    """Erase background for a STATE cell.

    Each state cell has three concentric regions: page-cream gap at the
    corners, a pastel rim ring, and a pastel pill body inside the rim. The
    character sits in the middle. We seed each background region separately,
    then sweep up stragglers via bounded rim erosion and small-blob cleanup.
    """
    img = cell.convert("RGBA").copy()
    w, h = img.size
    # Pass 1: corner flood → erase page-cream gap.
    for cx, cy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(img, (cx, cy), (0, 0, 0, 0), thresh=20)
    # Pass 2: pill-body flood from points safely inside the pill (still on
    # pill background, never on the character). Two seeds catch the body on
    # either side of the character.
    for sx, sy in [(50, 50), (w - 50, 50)]:
        if img.getpixel((sx, sy))[3] > 0:
            ImageDraw.floodfill(img, (sx, sy), (0, 0, 0, 0), thresh=30)
    # Pass 3: rim erosion, restricted to within BORDER_MARGIN of the cell
    # edge. The rim ring runs along the cell border; light dog fur further
    # inside the pill (pomeranian-style fluff) is outside the margin and
    # therefore protected. Each iteration peels one pixel of rim from the
    # transparent side; rim is ~3-5 px thick so a few iterations are enough.
    px = img.load()

    def neighbor_is_transparent(nx: int, ny: int) -> bool:
        if not (0 <= nx < w and 0 <= ny < h):
            return True
        return px[nx, ny][3] == 0

    def near_border(x: int, y: int) -> bool:
        return (
            x < BORDER_MARGIN
            or x >= w - BORDER_MARGIN
            or y < BORDER_MARGIN
            or y >= h - BORDER_MARGIN
        )

    for _ in range(20):
        frontier: list[tuple[int, int]] = []
        for y in range(h):
            for x in range(w):
                if not near_border(x, y):
                    continue
                r, g, b, a = px[x, y]
                if a == 0 or not is_rim_like(r, g, b):
                    continue
                if (
                    neighbor_is_transparent(x + 1, y)
                    or neighbor_is_transparent(x - 1, y)
                    or neighbor_is_transparent(x, y + 1)
                    or neighbor_is_transparent(x, y - 1)
                ):
                    frontier.append((x, y))
        if not frontier:
            break
        for x, y in frontier:
            px[x, y] = (0, 0, 0, 0)
    # Pass 4: erase small rim-like blobs trapped near the cell top/bottom.
    # These are pill-body regions enclosed by the dog's outline (e.g. the
    # strip between two ears, or below the chin in some poses) that no flood
    # reached. We restrict cleanup to the top/bottom TRAPPED_EDGE_BAND px so
    # vertically-centered rim-like features inside the face — eye whites,
    # mouth highlights — are preserved. Connected components use 4-connectivity
    # with color-strict propagation so the dark outline doesn't bridge a
    # trapped pocket to the dog's body fur.
    visited = [[False] * h for _ in range(w)]
    for sy in range(h):
        for sx in range(w):
            if visited[sx][sy]:
                continue
            r, g, b, a = px[sx, sy]
            if a == 0 or not is_rim_like(r, g, b):
                continue
            comp: list[tuple[int, int]] = []
            min_y, max_y = h, 0
            stack = [(sx, sy)]
            while stack:
                x, y = stack.pop()
                if not (0 <= x < w and 0 <= y < h) or visited[x][y]:
                    continue
                pr, pg, pb, pa = px[x, y]
                if pa == 0 or not is_rim_like(pr, pg, pb):
                    continue
                visited[x][y] = True
                comp.append((x, y))
                if y < min_y: min_y = y
                if y > max_y: max_y = y
                stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
            in_top_band = max_y < TRAPPED_EDGE_BAND
            in_bot_band = min_y >= h - TRAPPED_EDGE_BAND
            if len(comp) < TRAPPED_BLOB_MAX and (in_top_band or in_bot_band):
                for x, y in comp:
                    px[x, y] = (0, 0, 0, 0)
    return img


def keep_largest_component(img: Image.Image) -> Image.Image:
    """Keep only the largest non-transparent connected component, erasing
    everything else. Uses 8-connectivity so 1-pixel gaps (common where ear
    outlines barely touch the head outline) don't fragment the dog. Accessories
    like laptops, sparkles, exclamation marks — and any leftover rim artifacts
    — become separate components and get dropped, leaving just the character.
    """
    img = img.copy()
    w, h = img.size
    px = img.load()
    visited = [[False] * h for _ in range(w)]
    largest: list[tuple[int, int]] = []
    largest_size = 0
    for sy in range(h):
        for sx in range(w):
            if visited[sx][sy] or px[sx, sy][3] == 0:
                continue
            comp: list[tuple[int, int]] = []
            stack = [(sx, sy)]
            while stack:
                x, y = stack.pop()
                if not (0 <= x < w and 0 <= y < h) or visited[x][y]:
                    continue
                if px[x, y][3] == 0:
                    continue
                visited[x][y] = True
                comp.append((x, y))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        if dx == 0 and dy == 0:
                            continue
                        stack.append((x + dx, y + dy))
            if len(comp) > largest_size:
                largest_size = len(comp)
                largest = comp
    if not largest:
        return img
    keep = set(largest)
    for y in range(h):
        for x in range(w):
            if (x, y) not in keep:
                px[x, y] = (0, 0, 0, 0)
    return img


def cell_to_transparent_icon(cell: Image.Image) -> Image.Image:
    """Erase background for an icon cell (column 0). The icon sits on a cream
    pill that matches the page gap color, so a single corner flood with a
    modest tolerance handles it."""
    img = cell.convert("RGBA").copy()
    w, h = img.size
    for cx, cy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(img, (cx, cy), (0, 0, 0, 0), thresh=30)
    return img


def tight_bbox(img: Image.Image) -> Image.Image:
    bbox = img.getbbox()
    if bbox is None:
        return img
    return img.crop(bbox)


def slice_sheet(src_path: Path, out_dir: Path) -> None:
    sheet = Image.open(src_path).convert("RGBA")

    pets_dir = out_dir / "pets"
    icons_dir = pets_dir / "breed_icons"
    pets_dir.mkdir(parents=True, exist_ok=True)
    icons_dir.mkdir(parents=True, exist_ok=True)

    for ri, breed in enumerate(BREEDS):
        y0, y1 = ROW_BOUNDS[ri]
        for ci in range(COLS):
            if ci == 0:
                # Icon-only crop: left portion of column 0.
                x0 = int(ci * COL_W) + ICON_X0
                x1 = int(ci * COL_W) + ICON_X1
            else:
                x0 = int(ci * COL_W) + INSET_X
                x1 = int((ci + 1) * COL_W) - INSET_X
            cell = sheet.crop((x0, y0, x1, y1))
            if ci == 0:
                transparent = cell_to_transparent_icon(cell)
            else:
                transparent = cell_to_transparent_state(cell)
                transparent = keep_largest_component(transparent)
            cropped = tight_bbox(transparent)
            if ci == 0:
                out_path = icons_dir / f"{breed}.png"
            else:
                state = STATES[ci - 1]
                out_path = pets_dir / f"{breed}_{state}.png"
            cropped.save(out_path, "PNG")
            print(f"wrote {out_path.relative_to(out_dir.parent)}  size={cropped.size}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--input",
        default=str(Path.home() / "Downloads" / "Gemini_Generated_Image_vyv2nvvyv2nvvyv2.png"),
        help="path to the 2752×1536 reference sheet",
    )
    p.add_argument(
        "--output",
        default=str(Path(__file__).parent.parent / "src" / "assets"),
        help="output base dir (contains pets/ and pets/breed_icons/)",
    )
    args = p.parse_args()
    slice_sheet(Path(args.input).expanduser(), Path(args.output).expanduser())


if __name__ == "__main__":
    main()
