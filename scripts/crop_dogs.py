"""Crop dog source composites into per-state PNGs.

Each source is a grid (3x2 landscape or 2x3 portrait) of BREED + 5 state panels.
Cell rectangles are detected per-source by subtracting the corner background
color, so layouts with title headers or varying padding work without overrides.
Within each detected cell, a fixed bottom fraction is trimmed to drop the label
band before the background is flood-filled away.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import label as cc_label

SRC_DIR = Path("/Users/dorothy/clawd-work/pet/DOG")
DEST_DIR = Path("/Users/dorothy/clawd-work/code-crew/src/assets/pets")

# Background flood-fill thresholds — same values as bg-remove-manual.py.
CORNER_THRESH = 30
INSET_PX = 40
INSET_THRESH = 35

# Cell detection — pixels whose distance from corner bg color exceeds this are
# considered "in a cell".
BG_DIST_THRESH = 25
# Smoothing window (in px) for the row/column projection signal.
SMOOTH_K = 20
# A run of "in cell" projection samples is treated as a real row/column only
# if it spans at least this fraction of the corresponding image dimension.
MIN_RUN_FRAC = 0.05
# Detection threshold relative to the smoothed projection's peak.
RUN_THRESH_FRAC = 0.35

LANDSCAPE_SLOTS = [
    ["BREED", "sleeping", "typing"],
    ["surprised", "disappointed", "relieved"],
]
PORTRAIT_SLOTS = [
    ["BREED", "sleeping"],
    ["surprised", "typing"],
    ["disappointed", "relieved"],
]


@dataclass
class LayoutConfig:
    cols: int
    rows: int
    slots: list[list[str]]
    # Fraction of detected cell height to drop from the bottom (the label band).
    label_trim: float = 0.14
    # For 3-col landscape sources, the BREED cell has the breed-name text to
    # the right of the face — keep only this left fraction of the cell.
    breed_horizontal_keep: float = 0.55
    # Inset (fraction of cell width/height) applied inward from each detected
    # cell edge so the rounded-rect frame line doesn't survive bg flood-fill.
    # The detected cell bbox includes the frame line (frame pixels register as
    # non-bg); we need to inset past frame thickness (~3-5px) to crop inside it.
    inset_frac: float = 0.04
    # Override applied only to the TOP edge of the last-row cells. Portrait
    # bottom-row cells have a thick dark rim band there that the corner-flood
    # can't bridge past; the crop must start inside the cell body. Other
    # edges keep the normal inset to avoid clipping artwork.
    inset_frac_top_last_row: float | None = None


LANDSCAPE = LayoutConfig(cols=3, rows=2, slots=LANDSCAPE_SLOTS)
PORTRAIT = LayoutConfig(
    cols=2, rows=3, slots=PORTRAIT_SLOTS, inset_frac_top_last_row=0.07
)


BREEDS: dict[str, tuple[str, LayoutConfig]] = {
    "BEAGLE": ("beagle", LANDSCAPE),
    "BORDER_COLLIE": ("border_collie", LANDSCAPE),
    "DALMATIAN": ("dalmatian", LANDSCAPE),
    "FRENCH_BULLDOG": ("french_bulldog", LANDSCAPE),
    "GOLDEN_RETRIEVER": ("golden_retriever", PORTRAIT),
    "POMERANIAN": ("pomeranian", LANDSCAPE),
    "SHIBA_INU": ("shiba_inu", LANDSCAPE),
    "SIBERIAN_HUSKY": ("siberian_husky", LANDSCAPE),
    "WELSH_CORGI": ("welsh_corgi", LANDSCAPE),
    "YORKSHIRE_TERRIER": ("yorkshire_terrier", LANDSCAPE),
}


def _smooth1d(a: np.ndarray, k: int = SMOOTH_K) -> np.ndarray:
    out = np.empty(len(a), dtype=float)
    for i in range(len(a)):
        s = max(0, i - k)
        e = min(len(a), i + k + 1)
        out[i] = a[s:e].mean()
    return out


def _runs(mask: np.ndarray, min_len: int) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    in_run = False
    start = 0
    for i, v in enumerate(mask):
        if v and not in_run:
            in_run = True
            start = i
        elif not v and in_run:
            in_run = False
            if i - start >= min_len:
                out.append((start, i))
    if in_run and len(mask) - start >= min_len:
        out.append((start, len(mask)))
    return out


def detect_cells(img: Image.Image, n_cols: int, n_rows: int) -> dict[tuple[int, int], tuple[int, int, int, int]]:
    """Detect each cell's bounding rectangle by background subtraction."""
    arr = np.array(img.convert("RGB"))
    h, w, _ = arr.shape
    bg = np.mean(
        [arr[5, 5], arr[5, w - 6], arr[h - 6, 5], arr[h - 6, w - 6]],
        axis=0,
    )
    dist = np.linalg.norm(arr.astype(float) - bg, axis=2)
    not_bg = dist > BG_DIST_THRESH

    col_proj = _smooth1d(not_bg.sum(axis=0).astype(float))
    row_proj = _smooth1d(not_bg.sum(axis=1).astype(float))
    col_runs = _runs(col_proj > col_proj.max() * RUN_THRESH_FRAC, int(w * MIN_RUN_FRAC))
    row_runs = _runs(row_proj > row_proj.max() * RUN_THRESH_FRAC, int(h * MIN_RUN_FRAC))

    # Some sources have stray non-background content (signatures, page numbers)
    # outside the panel grid. Keep the largest N runs and re-sort by position.
    def _largest_n(runs: list[tuple[int, int]], n: int) -> list[tuple[int, int]]:
        if len(runs) < n:
            return runs
        runs = sorted(runs, key=lambda r: r[1] - r[0], reverse=True)[:n]
        return sorted(runs)

    col_runs = _largest_n(col_runs, n_cols)
    row_runs = _largest_n(row_runs, n_rows)

    if len(col_runs) != n_cols or len(row_runs) != n_rows:
        raise RuntimeError(
            f"Cell detection mismatch: got {len(col_runs)} cols / {len(row_runs)} rows, "
            f"expected {n_cols} / {n_rows}"
        )

    # Per-cell detected boxes vary in size because artwork bounds vary. Normalize
    # row heights to the largest detected row so cells with shorter artwork still
    # capture the full label band; same for column widths.
    row_h = max(b - t for t, b in row_runs)
    col_w = max(r - l for l, r in col_runs)
    cells: dict[tuple[int, int], tuple[int, int, int, int]] = {}
    for r, (t, b) in enumerate(row_runs):
        # Anchor first row by its top, last row by its bottom, middle rows by midpoint.
        if r == 0:
            top, bot = t, t + row_h
        elif r == n_rows - 1:
            top, bot = b - row_h, b
        else:
            mid = (t + b) // 2
            top, bot = mid - row_h // 2, mid - row_h // 2 + row_h
        for c, (l, ri) in enumerate(col_runs):
            if c == 0:
                left, right = l, l + col_w
            elif c == n_cols - 1:
                left, right = ri - col_w, ri
            else:
                mid_c = (l + ri) // 2
                left, right = mid_c - col_w // 2, mid_c - col_w // 2 + col_w
            cells[(r, c)] = (
                max(0, left),
                max(0, top),
                min(w, right),
                min(h, bot),
            )
    return cells


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
        if not (0 <= sx < w and 0 <= sy < h):
            continue
        px = img.getpixel((sx, sy))
        if px[3] == 0:
            continue
        # Skip seeds that didn't land on a light background pixel — otherwise
        # an inset seed that happens to fall on the character's outline floods
        # the outline away. Cell bodies are white/cream/lavender (min ch ≥ 180),
        # outlines and shaded fur are well below.
        if min(px[0], px[1], px[2]) < 180:
            continue
        ImageDraw.floodfill(img, (sx, sy), (0, 0, 0, 0), thresh=INSET_THRESH)
    # After flood-fill, the cell's rounded-rect frame line may survive as a
    # thin border at the image perimeter. Drop edge-touching alpha components
    # that are too small to be pet artwork — keep larger ones (which include
    # paws/cushions that incidentally reach the cropped image edge).
    arr = np.array(img)
    alpha = arr[..., 3] > 0
    labeled, n = cc_label(alpha)
    if n > 0:
        edge_labels = set(labeled[0, :]) | set(labeled[-1, :]) | set(labeled[:, 0]) | set(labeled[:, -1])
        edge_labels.discard(0)
        sizes = np.bincount(labeled.ravel())
        # Keep edge-touching components whose pixel count exceeds 0.5% of the
        # image — pet/speech-bubble are much larger; border lines are smaller.
        min_keep = int(alpha.size * 0.005)
        drop = [lbl for lbl in edge_labels if sizes[lbl] < min_keep]
        if drop:
            mask = np.isin(labeled, drop)
            arr[..., 3][mask] = 0
            img = Image.fromarray(arr)
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def process(src_path: Path, breed: str, layout: LayoutConfig, dest_dir: Path) -> list[Path]:
    img = Image.open(src_path).convert("RGBA")
    cells = detect_cells(img, layout.cols, layout.rows)
    icon_dir = dest_dir / "breed_icons"
    icon_dir.mkdir(exist_ok=True)
    written: list[Path] = []
    for r, row_slots in enumerate(layout.slots):
        for c, slot in enumerate(row_slots):
            left, top, right, bot = cells[(r, c)]
            cell_h = bot - top
            cell_w = right - left
            inset_x = round(cell_w * layout.inset_frac)
            inset_y = round(cell_h * layout.inset_frac)
            inset_top = inset_y
            if (
                r == layout.rows - 1
                and layout.inset_frac_top_last_row is not None
            ):
                inset_top = round(cell_h * layout.inset_frac_top_last_row)
            left += inset_x
            right -= inset_x
            top += inset_top
            bot -= inset_y
            cell_h = bot - top
            bot_adj = bot - round(cell_h * layout.label_trim)
            cell = img.crop((left, top, right, bot_adj))
            if slot == "BREED":
                if layout.cols == 3:
                    cw, ch = cell.size
                    cell = cell.crop((0, 0, int(cw * layout.breed_horizontal_keep), ch))
                cell = remove_bg(cell)
                out = icon_dir / f"{breed}.png"
            else:
                cell = remove_bg(cell)
                out = dest_dir / f"{breed}_{slot}.png"
            cell.save(out, "PNG")
            written.append(out)
    return written


def main() -> None:
    for src_name, (breed, layout) in BREEDS.items():
        src = SRC_DIR / f"{src_name}.png"
        if not src.exists():
            print(f"SKIP (missing): {src}")
            continue
        try:
            outs = process(src, breed, layout, DEST_DIR)
        except RuntimeError as exc:
            print(f"{src_name}: FAILED — {exc}")
            continue
        print(f"{src_name}: wrote {len(outs)} files")


if __name__ == "__main__":
    main()
