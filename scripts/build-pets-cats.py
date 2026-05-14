#!/usr/bin/env python3
"""Slice cat sprite sheets (one PNG per breed) into per-state PNGs.

Layout differs from the dog reference sheet: each cat breed is its own
2528 × 1696 PNG containing a 3-column × 2-row grid of pose cells. The grid
order is fixed:

    [BREED]      [SLEEPING]      [TYPING]
    [SURPRISED]  [DISAPPOINTED]  [RELIEVED]

Each cell has the character drawing in the upper portion (lavender pill
body, dark purple rim) and a white-on-purple label band along the bottom.
The label is stripped by cropping the bottom ~15% of each cell before
running the same background-flood / rim-erosion / largest-component
pipeline that `build-pets.py` uses for the dog sheet.

Background removal targets three lavender shades observed in the source:
  - page lavender (~217, 204, 250) — outside the pill
  - pill body (~235, 225, 252)     — inside the rim
  - rim / label (~160, 145, 205)   — pill border and the bottom band
"""
from __future__ import annotations
import argparse
from pathlib import Path
from PIL import Image, ImageDraw

# Filename in pet/ → breed_id. Filenames are SCREAMING_CASE; ids are
# snake_case to match the dog convention.
CAT_BREEDS: list[tuple[str, str, str]] = [
    # (filename_stem, breed_id, display label)
    ("BLACK_CAT",      "black_cat",      "Black Cat"),
    ("CALICO",         "calico",         "Calico"),
    ("MAINE_COON",     "maine_coon",     "Maine Coon"),
    ("MUNCHKIN",       "munchkin",       "Munchkin"),
    ("ORANGE_TABBY",   "orange_tabby",   "Orange Tabby"),
    ("PERSIAN",        "persian",        "Persian"),
    ("RUSSIAN_BLUE",   "russian_blue",   "Russian Blue"),
    ("SCOTTISH_FOLD",  "scottish_fold",  "Scottish Fold"),
    ("SIAMESE",        "siamese",        "Siamese"),
    ("TUXEDO_CAT",     "tuxedo_cat",     "Tuxedo Cat"),
]

# Cell index within the 3×2 grid → state name. Index = row*3 + col.
# Cell 0 is the breed icon (saved to breed_icons/), others map to PetState.
CELL_TO_STATE: list[str] = [
    "icon",         # [0,0]
    "sleeping",     # [0,1]
    "typing",       # [0,2]
    "surprised",    # [1,0]
    "disappointed", # [1,1]
    "relieved",     # [1,2]
]

GRID_COLS = 3
GRID_ROWS = 2

# Bottom fraction of each cell occupied by the label band + the gap below
# it. Empirically the label band sits at cell-y ≈ 730–830 with the cell
# spanning 0–848; cropping 18% off the bottom (≈ y=695) clears the band
# along with a hair of the pill-bottom curve, which the flood-fill cleans
# up. Going tighter risks leaving label fragments when a cat's pose
# overlaps the band (e.g. a tail dangling into the label area).
LABEL_BOTTOM_FRACTION = 0.18

# Persian's sheet is the odd one out — each cell has a purple "N. STATE" band
# riveted to the TOP of the cell that the perimeter flood can't reliably crack
# (because the band's lower edge is a dark rim line connected to the cell
# frame). Strip the top 14% upfront before any pixel work to guarantee the
# band is gone, then the flood pipeline handles the rest like any other cat.
TOP_LABEL_FRACTION_BY_STEM: dict[str, float] = {
    # Persian's "N. STATE" band runs from y≈55 to y≈170 in the source's
    # 848-tall cells; 0.22 (~187 px) clears the band plus the page-lavender
    # gap above. A tighter strip leaves enough band visible to register as a
    # large connected component that wins over the laptop in the typing cell.
    "PERSIAN": 0.22,
}

# Breeds whose cell has a coloured INTERIOR ring (lavender frame around a cream
# centre): russian_blue and scottish_fold are drawn this way. For those the
# four-corner + shallow-inset passes only strip the frame, leaving the cream
# inside — Pass 2b's deep inset is needed to reach it. Applying Pass 2b to a
# normal-layout cat (where the cell is one uniform colour) would land on the
# character body and hollow it out, so the deep flood is opt-in per breed.
DEEP_INSET_STEMS: set[str] = {"RUSSIAN_BLUE", "SCOTTISH_FOLD"}

# Bounded rim-erosion: any pixel within this many px of the cell border
# that still looks rim-like after the floods runs gets stripped. Wide
# enough to chase the rounded inner edge of the rim ring, narrow enough
# to leave the character body alone.
BORDER_MARGIN = 24

# Small rim-coloured blobs trapped near the top/bottom of the cell
# (pill-body enclaves between ear tips, under chins, behind tails) get
# erased. The threshold is a pixel count — anything bigger is assumed to
# be part of the character.
TRAPPED_BLOB_MAX = 1800
TRAPPED_EDGE_BAND = 50


def is_rim_like(r: int, g: int, b: int) -> bool:
    """Cat sheet rim/label band: medium lavender (~160,145,205).

    Match a wider purple range than the dog sheet uses because the cat
    rim has stronger blue lift. Exclude dark character outlines
    (min < 80) and saturated facial features (max-min ≥ 110).
    """
    return min(r, g, b) > 80 and (max(r, g, b) - min(r, g, b)) < 110


def is_light_bg(r: int, g: int, b: int) -> bool:
    """Light, low-saturation pixel — looks like cell-interior background.

    Used to gate the deep-inset flood (Pass 3) so we only erase the cell's
    inner background colour (cream / peach / pale lavender ≈ 240-255 across
    channels) and never the character itself. The character is either dark
    (black cat, husky, etc.) or saturated (orange tabby, calico patches)
    — both fail the saturation check below.
    """
    return min(r, g, b) > 180 and (max(r, g, b) - min(r, g, b)) < 50


def cell_to_transparent(cell: Image.Image, deep_inset: bool = False) -> Image.Image:
    """Erase page lavender, pill body, and rim — leaving just the character.

    Mirrors `build-pets.py::cell_to_transparent_state` with thresholds tuned
    for the cat sheet's lavender palette. Four passes: corner flood, shallow
    inset flood, rim erosion, trapped-blob cleanup. An optional deep-inset
    pass (Pass 2b) handles the few sheets that wrap their cells in a tinted
    frame around an even-lighter interior — see DEEP_INSET_STEMS.
    """
    img = cell.convert("RGBA").copy()
    w, h = img.size

    # Pass 1: corner flood erases the page lavender that surrounds the pill.
    for cx, cy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(img, (cx, cy), (0, 0, 0, 0), thresh=25)

    # Pass 2: pill-body flood. Seeds are inset enough to land on the
    # light-lavender interior even after the rounded-rim corners eat into
    # the cell. Four seeds catch the body on each side of a central
    # character so no quadrant of the pill is missed.
    for sx, sy in [(60, 60), (w - 60, 60), (60, h - 60), (w - 60, h - 60)]:
        if img.getpixel((sx, sy))[3] > 0:
            ImageDraw.floodfill(img, (sx, sy), (0, 0, 0, 0), thresh=35)

    # Pass 2b (opt-in): deep inset (≈140 px) for sheets whose cells have a
    # coloured ring with a lighter interior — Pass 2 only strips the ring.
    # Restricted to the upper inset positions so the seed lands above the
    # character (which always sits in the bottom/centre of the cell). The
    # is_light_bg gate is belt-and-braces: skip the flood if the seed pixel
    # somehow ended up on a darker / saturated colour (e.g. eye, fur).
    if deep_inset:
        for sx, sy in [(140, 140), (w - 140, 140)]:
            if 0 <= sx < w and 0 <= sy < h:
                r, g, b, a = img.getpixel((sx, sy))
                if a > 0 and is_light_bg(r, g, b):
                    ImageDraw.floodfill(img, (sx, sy), (0, 0, 0, 0), thresh=30)

    # Pass 3: rim erosion within BORDER_MARGIN of the cell edge. Strips
    # the dark-purple rim ring iteratively, one pixel-layer per pass.
    px = img.load()

    def transparent_neighbor(nx: int, ny: int) -> bool:
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

    for _ in range(24):
        frontier: list[tuple[int, int]] = []
        for y in range(h):
            for x in range(w):
                if not near_border(x, y):
                    continue
                r, g, b, a = px[x, y]
                if a == 0 or not is_rim_like(r, g, b):
                    continue
                if (
                    transparent_neighbor(x + 1, y)
                    or transparent_neighbor(x - 1, y)
                    or transparent_neighbor(x, y + 1)
                    or transparent_neighbor(x, y - 1)
                ):
                    frontier.append((x, y))
        if not frontier:
            break
        for x, y in frontier:
            px[x, y] = (0, 0, 0, 0)

    # Pass 3b (opt-in): unbounded rim chase for frame-around-interior layouts.
    # Pass 2 / 2b clear the frame and the cream interior, but anti-aliased
    # pixels at their shared boundary fall between both colour thresholds and
    # survive as a faint lavender outline well inside the cell (beyond
    # BORDER_MARGIN, so Pass 3 can't reach it). Walk the whole cell, no border
    # restriction, chasing any rim-like pixel that touches a transparent
    # neighbour. The chase halts at the character's dark outline (min channel
    # < 80, so not rim-like), keeping the cat itself intact.
    if deep_inset:
        for _ in range(40):
            frontier = []
            for y in range(h):
                for x in range(w):
                    r, g, b, a = px[x, y]
                    if a == 0 or not is_rim_like(r, g, b):
                        continue
                    if (
                        transparent_neighbor(x + 1, y)
                        or transparent_neighbor(x - 1, y)
                        or transparent_neighbor(x, y + 1)
                        or transparent_neighbor(x, y - 1)
                    ):
                        frontier.append((x, y))
            if not frontier:
                break
            for x, y in frontier:
                px[x, y] = (0, 0, 0, 0)

    # Pass 4: erase rim-coloured blobs trapped near the top/bottom edge
    # band. These are pill enclaves hemmed in by the character outline
    # (between ears, behind a curled tail) that no flood reached. Blobs
    # vertically centred — eye whites, mouth highlights — stay put.
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
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
                stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
            in_top_band = max_y < TRAPPED_EDGE_BAND
            in_bot_band = min_y >= h - TRAPPED_EDGE_BAND
            if len(comp) < TRAPPED_BLOB_MAX and (in_top_band or in_bot_band):
                for x, y in comp:
                    px[x, y] = (0, 0, 0, 0)
    return img


def keep_largest_component(img: Image.Image, secondary_threshold: float = 0.30) -> Image.Image:
    """Keep the largest 8-connected component plus any others ≥ 30% its size.

    The size gate drops free-floating iconography — sparkles in RELIEVED,
    exclamation marks in SURPRISED, tear drops in DISAPPOINTED — that's
    always orders of magnitude smaller than the character. The secondary
    bucket exists for the TYPING cells where the laptop sits as its own
    component (e.g. Persian, where the artist drew the cat with a small
    gap between paw and keyboard); at ~50% of the cat's mass it clears the
    30% threshold and survives. Same dog-pipeline behaviour for connected
    laptops where the paw bridges the two regions into one big component.
    """
    img = img.copy()
    w, h = img.size
    px = img.load()
    visited = [[False] * h for _ in range(w)]
    components: list[list[tuple[int, int]]] = []
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
            components.append(comp)
    if not components:
        return img
    components.sort(key=len, reverse=True)
    largest_size = len(components[0])
    cutoff = int(largest_size * secondary_threshold)
    keep: set[tuple[int, int]] = set()
    for comp in components:
        if len(comp) < cutoff and len(keep) > 0:
            break
        keep.update(comp)
    for y in range(h):
        for x in range(w):
            if (x, y) not in keep:
                px[x, y] = (0, 0, 0, 0)
    return img


def tight_bbox(img: Image.Image) -> Image.Image:
    bbox = img.getbbox()
    if bbox is None:
        return img
    return img.crop(bbox)


def slice_sheet(src_path: Path, breed_id: str, out_dir: Path) -> None:
    sheet = Image.open(src_path).convert("RGBA")
    W, H = sheet.size
    top_strip_frac = TOP_LABEL_FRACTION_BY_STEM.get(src_path.stem, 0.0)
    deep_inset = src_path.stem in DEEP_INSET_STEMS

    pets_dir = out_dir / "pets"
    icons_dir = pets_dir / "breed_icons"
    pets_dir.mkdir(parents=True, exist_ok=True)
    icons_dir.mkdir(parents=True, exist_ok=True)

    for idx, label_state in enumerate(CELL_TO_STATE):
        ri, ci = divmod(idx, GRID_COLS)
        x0 = ci * W // GRID_COLS
        x1 = (ci + 1) * W // GRID_COLS
        cell_y0 = ri * H // GRID_ROWS
        cell_y1 = (ri + 1) * H // GRID_ROWS
        cell_h = cell_y1 - cell_y0
        # Strip the bottom label band before any pixel work — same palette as
        # the rim, would otherwise survive every pass.
        y1 = cell_y1 - int(cell_h * LABEL_BOTTOM_FRACTION)
        # For sheets with a top label band ("N. STATE" on a coloured strip,
        # e.g. PERSIAN), also strip the top before flooding.
        y0_strip = cell_y0 + int(cell_h * top_strip_frac)

        cell = sheet.crop((x0, y0_strip, x1, y1))
        transparent = cell_to_transparent(cell, deep_inset=deep_inset)
        # Apply largest-component selection to BOTH icon and state cells.
        # Earlier the icon was assumed accessory-free, but some sheets place
        # a breed-name watermark inside the BREED cell (russian_blue: "RUSSIAN
        # BLUE (라벨)" floats above the cat); the watermark text survives flood
        # and rim chase because the strokes are dark/non-rim-coloured. Treating
        # the icon the same way as states drops any disconnected text.
        transparent = keep_largest_component(transparent)
        cropped = tight_bbox(transparent)

        if label_state == "icon":
            out_path = icons_dir / f"{breed_id}.png"
        else:
            out_path = pets_dir / f"{breed_id}_{label_state}.png"
        cropped.save(out_path, "PNG")
        print(f"wrote {out_path.relative_to(out_dir.parent)}  size={cropped.size}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--input-dir",
        default=str(Path.home() / "clawd-work" / "pet"),
        help="directory of source PNGs (one per cat breed, e.g. BLACK_CAT.png)",
    )
    p.add_argument(
        "--output",
        default=str(Path(__file__).parent.parent / "src" / "assets"),
        help="output base dir (contains pets/ and pets/breed_icons/)",
    )
    args = p.parse_args()

    input_dir = Path(args.input_dir).expanduser()
    out_dir = Path(args.output).expanduser()

    for stem, breed_id, _label in CAT_BREEDS:
        src = input_dir / f"{stem}.png"
        if not src.exists():
            print(f"SKIP {breed_id}: missing {src}")
            continue
        slice_sheet(src, breed_id, out_dir)


if __name__ == "__main__":
    main()
