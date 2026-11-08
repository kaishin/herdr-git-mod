#!/usr/bin/env python3
"""Compose the 2560x1280 (1280x640 at 2x) gallery preview from a native Herdr capture.

1. Open the synthetic preview (no repository, network, or layout writes):
       python3 scripts/check-ui.py --preview history --size 900x580
       herdr-app shot /tmp/herdr-git-capture.png
   then close the overlay and run `python3 scripts/check-ui.py --clean-preview`.
2. Crop the overlay out of the window capture. This step only crops; it keeps
   the native pixels and records where they came from:
       python3 scripts/compose-preview.py --capture /tmp/herdr-git-capture.png --crop X,Y,W,H
3. Compose again at any time from the kept source:
       python3 scripts/compose-preview.py

Needs Pillow and the SF Pro fonts (macOS). Text and placement are constants below.
"""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/preview-source.png"
PROVENANCE = ROOT / "docs/preview-source.json"
OUTPUT = ROOT / "preview.png"

SCALE = 2                     # output is 2560x1280; layout values below are at 1x
SIZE = (1280 * SCALE, 640 * SCALE)
TITLE = "Git"
EYEBROW = "HERDR · MOD"
STRIPES = ((0, 0, 0), (24, 24, 26))   # black and dark gray, alternating diagonal bands
STRIPE = 8                    # band width at 1x
# Tints from the graph lanes (Atom One Dark ANSI blue, green, purple, yellow, cyan).
BLUE, GREEN, PURPLE, YELLOW, CYAN = (97, 175, 239), (152, 195, 121), (198, 120, 221), (229, 192, 123), (86, 182, 194)
MUTED = (150, 156, 168)
EYEBROW_COLOR = CYAN
TITLE_COLORS = [BLUE, GREEN, PURPLE]          # one per letter of TITLE
BAR_COLORS = [BLUE, GREEN, PURPLE, YELLOW, CYAN]
# Subtitle lines as (text, color) runs: key phrases tinted, the rest muted.
SUBTITLE = [
    [("Commit graph", BLUE), (", ", MUTED), ("pull requests", GREEN), (" and", MUTED)],
    [("branch sync", PURPLE), (" in a native panel.", MUTED)],
    [("Every checkout, pull and push", MUTED)],
    [("asks first", YELLOW), (".", MUTED)],
]
CARD = (548, 0, 692)          # left edge, (computed top), width of the screenshot card at 1x
CORNER = 22                   # capture pixels; covers the window's corner radius at 2x
FONTS = ["/Library/Fonts", str(Path.home() / "Library/Fonts"), "/System/Library/Fonts"]


def font(name, size):
    for folder in FONTS:
        path = Path(folder) / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    raise SystemExit(f"Font not found: {name}")


def crop(capture, box):
    x, y, w, h = (int(n) for n in box.split(","))
    image = Image.open(capture).convert("RGBA").crop((x, y, x + w, y + h))
    # The window has rounded corners; whatever showed behind them is cleared.
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), CORNER, fill=255)
    image.putalpha(mask)
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    image.save(SOURCE)
    PROVENANCE.write_text(json.dumps({
        "source": "herdr-app shot native window capture",
        "content": "scripts/check-ui.py --preview history --size 900x580: synthetic fixtures, no real repository or GitHub data",
        "processing": f"Cropped to the preview window at {x},{y} {w}x{h}; pixels outside its {CORNER}px rounded corners made transparent; no other changes",
        "capture": Path(capture).name,
    }, indent=2) + "\n")


def stripes():
    canvas = Image.new("RGB", SIZE, STRIPES[0])
    d, band = ImageDraw.Draw(canvas), STRIPE * SCALE
    w, h = SIZE
    for x in range(-h, w + h, band * 2):
        d.polygon([(x, h), (x + band, h), (x + band + h, 0), (x + h, 0)], fill=STRIPES[1])
    return canvas


def compose():
    k = SCALE
    canvas = stripes()

    shot = Image.open(SOURCE).convert("RGBA")
    left, width = CARD[0] * k, CARD[2] * k
    height = round(shot.height * width / shot.width)
    top = (SIZE[1] - height) // 2
    shot = shot.resize((width, height), Image.LANCZOS)
    radius = 12 * k
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius, fill=255)
    mask = Image.composite(shot.getchannel("A"), mask, mask)
    shadow = Image.new("L", SIZE, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((left, top + 14 * k, left + width, top + height + 14 * k), radius, fill=170)
    canvas.paste((0, 0, 0), (0, 0), shadow.filter(ImageFilter.GaussianBlur(26 * k)))
    canvas.paste(shot, (left, top), mask)
    ImageDraw.Draw(canvas).rounded_rectangle((left - k, top - k, left + width + k - 1, top + height + k - 1), radius + k, outline=(52, 56, 64), width=k)

    d = ImageDraw.Draw(canvas)
    x = 72 * k
    eyebrow, title, body = font("SF-Pro-Text-Semibold.otf", 17 * k), font("SF-Pro-Display-Bold.otf", 128 * k), font("SF-Pro-Display-Regular.otf", 25 * k)
    y = 150 * k
    d.text((x, y), EYEBROW, font=eyebrow, fill=EYEBROW_COLOR)
    y += 40 * k
    tx = x
    for i, letter in enumerate(TITLE):
        # Advance by the kerned prefix width so per-letter colors keep the word's spacing.
        tx = x + title.getlength(TITLE[:i])
        d.text((tx, y - title.getbbox(TITLE)[1]), letter, font=title, fill=TITLE_COLORS[i % len(TITLE_COLORS)])
    y += title.getbbox(TITLE)[3] - title.getbbox(TITLE)[1] + 30 * k
    segment, gap = 16 * k, 4 * k
    for i, color in enumerate(BAR_COLORS):
        sx = x + i * (segment + gap)
        d.rounded_rectangle((sx, y, sx + segment, y + 4 * k), 2 * k, fill=color)
    y += 34 * k
    for line in SUBTITLE:
        rx = x
        for text, color in line:
            d.text((rx, y), text, font=body, fill=color)
            rx += body.getlength(text)
        y += 36 * k
    canvas.save(OUTPUT, optimize=True)
    print(OUTPUT)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture", help="herdr-app shot PNG to crop into docs/preview-source.png")
    parser.add_argument("--crop", help="X,Y,W,H of the preview window in the capture, in pixels")
    parser.add_argument("--source", help="compose from this image instead of docs/preview-source.png (layout trials only)")
    args = parser.parse_args()
    global SOURCE
    if args.capture:
        if not args.crop:
            raise SystemExit("--capture needs --crop")
        crop(args.capture, args.crop)
    elif args.source:
        SOURCE = Path(args.source)
    compose()


if __name__ == "__main__":
    main()
