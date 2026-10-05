"""Lays out cache-watch's states, captured from the Claude desktop app, into one header image.

Usage: python3 compose.py <captures dir> <out.png>

The captures dir holds one full-window grab of the Claude desktop app per state, named
warm.png, expiring.png, expired.png, model.png, compacted.png and working.png. The band and
prompt box sit at fixed offsets from the window's bottom edge, so the crops are measured from there.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

CAPS = Path(sys.argv[1])
OUT = Path(sys.argv[2])

S = 2  # render scale: 1x captures, 2x canvas, so the image stays sharp on retina screens
FONT = '/Applications/Claude.app/Contents/Resources/fonts/AnthropicSans-Romans-Variable-25x258.ttf'
MONO = '/System/Library/Fonts/SFNSMono.ttf'

BG = (14, 14, 13)
CARD_EDGE = (44, 44, 42)
TEXT = (240, 238, 230)
MUTED = (150, 148, 140)
ORANGE = (217, 119, 87)
STATE = {
    'green': (34, 197, 94),
    'yellow': (234, 179, 8),
    'red': (239, 68, 68),
}

HERO = ('warm', 'green', 'Warm', 'Time left on the cache, and what it costs your next message')
STRIPS = [
    ('expiring', 'yellow', 'Expiring', 'Under 10 minutes left on a 1-hour cache, or 90 seconds on a 5-minute one'),
    ('expired', 'red', 'Expired', 'The cache is gone: your next message pays to rebuild it'),
    ('model', 'red', 'Model changed', "A new model can't reuse the old model's cache"),
    ('compacted', 'yellow', 'Compacted', 'The summary starts a fresh cache'),
    ('working', 'green', 'Working', 'Every request Claude makes refreshes the timer'),
]


def font(size: float, weight: int = 400, path: str = FONT) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(path, round(size * S))
    if path == FONT:
        f.set_variation_by_axes([weight])

    return f


def crop(name: str, top_from_bottom: int, bottom_from_bottom: int, pad: int) -> Image.Image:
    im = Image.open(CAPS / f'{name}.png').convert('RGB')
    w, h = im.size
    left, right = band_columns(im)
    box = (left - pad, h - top_from_bottom, right + 1 + pad, h - bottom_from_bottom)

    return im.crop(box).resize(((box[2] - box[0]) * S, (box[3] - box[1]) * S), Image.NEAREST)


def band_columns(im: Image.Image) -> tuple[int, int]:
    """Left and right edge of the band's box, scanning its middle row."""
    w, h = im.size
    y = h - 101  # middle of the band, measured from the bottom
    bg = im.getpixel((w - 4, y))
    xs = [x for x in range(w // 4, w) if im.getpixel((x, y)) != bg and sum(im.getpixel((x, y))) < 3 * 60]

    return xs[0], xs[-1]


def rounded(img: Image.Image, radius: int) -> Image.Image:
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius, fill=255)
    out = Image.new('RGBA', img.size)
    out.paste(img, (0, 0), mask)

    return out


def place_card(canvas: Image.Image, img: Image.Image, x: int, y: int, r: int) -> None:
    shadow = Image.new('RGBA', (img.width + 80 * S, img.height + 80 * S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (40 * S, 46 * S, 40 * S + img.width, 46 * S + img.height), r, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14 * S))
    canvas.alpha_composite(shadow, (x - 40 * S, y - 40 * S))
    canvas.alpha_composite(rounded(img, r), (x, y))
    ImageDraw.Draw(canvas).rounded_rectangle(
        (x, y, x + img.width - 1, y + img.height - 1), r, outline=CARD_EDGE, width=S)


def label(draw: ImageDraw.ImageDraw, x: int, y: int, color: str, name: str, text: str) -> None:
    dot = 4 * S
    draw.ellipse((x, y + 6 * S, x + 2 * dot, y + 6 * S + 2 * dot), fill=STATE[color])
    x += 2 * dot + 9 * S
    f_name = font(14.5, 600)
    draw.text((x, y), name, font=f_name, fill=TEXT)
    x += draw.textlength(name, font=f_name) + 10 * S
    draw.text((x, y + 1 * S), text, font=font(13.5), fill=MUTED)


# The hero shows where the band lives: the band, the prompt box and the row under it.
hero = crop(HERO[0], 129, 2, 12)
# The strips show the band alone.
strips = [(s, crop(s[0], 121, 81, 0)) for s in STRIPS]  # exactly the band's own box

M = 48 * S
TX = M + 12 * S  # text column: lines up with the bands' left edge
W = hero.width + 2 * M
GAP = 30 * S
LABEL_H = 30 * S
H = (184 * S + LABEL_H + hero.height + 40 * S
     + sum(LABEL_H + img.height + GAP for _, img in strips) + 18 * S)

canvas = Image.new('RGBA', (W, H), BG + (255,))
glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse((-W // 4, -260 * S, W // 2, 200 * S), fill=ORANGE + (34,))
canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(90 * S)))
draw = ImageDraw.Draw(canvas)

# Wordmark and tagline
y = 44 * S
f_mark = font(38, 700)
draw.text((TX, y), 'cache', font=f_mark, fill=ORANGE)
draw.text((TX + draw.textlength('cache', font=f_mark), y), '-watch', font=f_mark, fill=TEXT)
y += 56 * S
draw.text((TX, y), 'Know when your prompt cache expires, and what that costs your next message.',
          font=font(17, 450), fill=TEXT)
y += 28 * S
f_note = font(13.5)
note = 'Every state below is a real capture from the Claude desktop app. Preview them with'
draw.text((TX, y), note, font=f_note, fill=MUTED)
cx = TX + draw.textlength(note, font=f_note) + 8 * S
f_code = font(12.5, path=MONO)
code = '/cachewatch demo'
cw = draw.textlength(code, font=f_code)
draw.rounded_rectangle((cx - 6 * S, y - 2 * S, cx + cw + 6 * S, y + 19 * S), 5 * S, fill=(38, 38, 36))
draw.text((cx, y + 1 * S), code, font=f_code, fill=TEXT)

# Hero
y = 184 * S
label(draw, M + 12 * S, y, HERO[1], HERO[2], HERO[3])
y += LABEL_H
place_card(canvas, hero, M, y, 14 * S)
y += hero.height + 34 * S

# Strips
for (_, color, name, text), img in strips:
    label(draw, M + 12 * S, y, color, name, text)
    y += LABEL_H
    # Strips are 12 px narrower than the hero's padded crop: centre them under it.
    place_card(canvas, img, M + 12 * S, y, 8 * S)
    y += img.height + GAP

canvas.convert('RGB').save(OUT, optimize=True)
print(OUT, canvas.size)
