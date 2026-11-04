"""Deterministic photo treatments and abstract textures in a design's own palette."""
import io
import math
import random

from PIL import Image, ImageColor, ImageDraw, ImageOps

TREATMENTS = ("halftone", "dither", "ordered", "diffuse", "duotone", "grain", "posterize")
PATTERNS = ("dots", "stripes", "grid", "waves", "topo", "confetti", "noise")
MAX_BYTES = 25 * 1024 * 1024
MAX_PIXELS = 40_000_000


def palette(tokens: dict) -> dict:
    def color(key, fallback):
        try:
            return ImageColor.getrgb(str(tokens.get(key) or fallback))[:3]
        except (ValueError, TypeError):
            return ImageColor.getrgb(fallback)
    text, bg = color("--ds-text", "#171717"), color("--ds-bg", "#f5f2e9")
    dark, light = sorted((text, bg), key=lambda c: sum(a*b for a, b in zip(c, (0.2126, 0.7152, 0.0722))))
    return {"dark": dark, "light": light, "accent": color("--ds-accent", "#d85838"),
            "accent2": color("--ds-accent-2", "#398c91")}


def _png(image):
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def _photo(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_BYTES:
        raise ValueError("Choose a photo no larger than 25 MB.")
    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > MAX_PIXELS:
                raise ValueError("Choose a photo no larger than 40 megapixels.")
            source.load()
            image = source.convert("RGB")
        image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
        return image
    except (OSError, Image.DecompressionBombError) as error:
        raise ValueError("That file is not a photo Kairos can read. Use PNG, JPEG, WebP or GIF.") from error


def apply(raw: bytes, treatment: str, tokens: dict) -> bytes:
    if treatment not in TREATMENTS:
        raise ValueError("Choose a treatment: " + ", ".join(TREATMENTS) + ".")
    image = _photo(raw)
    colors = palette(tokens)
    gray = ImageOps.grayscale(image)
    if treatment == "duotone":
        image = ImageOps.colorize(gray, colors["dark"], colors["light"], mid=colors["accent"] if tokens.get("--ds-accent") else None)
    elif treatment == "halftone":
        cell = max(4, max(image.size) // 140)
        image = Image.new("RGB", image.size, colors["light"])
        draw = ImageDraw.Draw(image)
        for y in range(0, image.height, cell):
            for x in range(0, image.width, cell):
                shade = gray.getpixel((min(x + cell//2, image.width-1), min(y + cell//2, image.height-1)))
                r = cell * 0.5 * math.sqrt(1 - shade / 255)
                cx, cy = x + cell/2, y + cell/2
                draw.ellipse((cx-r, cy-r, cx+r, cy+r), fill=colors["dark"])
    elif treatment in ("dither", "ordered", "diffuse"):
        if treatment == "diffuse":
            gray = gray.convert("1", dither=Image.Dither.FLOYDSTEINBERG).convert("L")
        else:
            matrix = [[0]]
            for _ in range(3):
                matrix = [[4 * matrix[y % len(matrix)][x % len(matrix)] + ((0, 2), (3, 1))[y // len(matrix)][x // len(matrix)]
                           for x in range(len(matrix)*2)] for y in range(len(matrix)*2)]
            pixels = bytes(255 if v > (matrix[(i // gray.width) % 8][i % gray.width % 8] + 0.5) * 4 else 0
                           for i, v in enumerate(gray.tobytes()))
            gray = Image.frombytes("L", gray.size, pixels)
        image = ImageOps.colorize(gray, colors["dark"], colors["light"])
    elif treatment == "grain":
        rng = random.Random(0)
        pixels = bytearray(image.tobytes())
        for i in range(0, len(pixels), 3):
            delta = rng.randint(-22, 22)
            for channel in range(3):
                pixels[i + channel] = max(0, min(255, pixels[i + channel] + delta))
        image = Image.frombytes("RGB", image.size, bytes(pixels))
    elif treatment == "posterize":
        swatch = Image.new("P", (1, 1))
        entries = list(colors.values())
        swatch.putpalette([v for color in (entries * 64) for v in color])
        image = image.quantize(palette=swatch, dither=Image.Dither.NONE).convert("RGB")
    return _png(image)


def pattern(kind, tokens, w=1600, h=1000, seed=0) -> bytes:
    if kind not in PATTERNS:
        raise ValueError("Choose a pattern: " + ", ".join(PATTERNS) + ".")
    if type(w) is not int or type(h) is not int or min(w, h) < 1 or max(w, h) > 2400:
        raise ValueError("Pattern dimensions must be 1 to 2400 pixels.")
    if type(seed) is not int:
        raise ValueError("Use a whole number for the pattern seed.")
    rng = random.Random(seed)
    colors = palette(tokens)
    image = Image.new("RGB", (w*2, h*2), colors["light"])
    draw = ImageDraw.Draw(image)
    ink = colors["accent"]
    step = max(24, max(w, h)//24) * 2
    width, height = image.size
    if kind == "dots":
        for y in range(step//2, height, step):
            for x in range(step//2, width, step):
                r = step/9
                draw.ellipse((x-r, y-r, x+r, y+r), fill=ink)
    elif kind == "stripes":
        for x in range(-height, width, step):
            draw.line((x, 0, x+height, height), fill=ink, width=max(2, step//5))
    elif kind == "grid":
        for x in range(0, width, step):
            draw.line((x, 0, x, height), fill=ink, width=2)
        for y in range(0, height, step):
            draw.line((0, y, width, y), fill=ink, width=2)
    elif kind in ("waves", "topo"):
        phase = rng.random()*6
        for y in range(-step*2, height+step*2, step//2):
            points = [(x, y + math.sin(x/step + phase)*step/3 +
                       (math.sin(x/(step*2.7) + y/(step*3))*step if kind == "topo" else 0)) for x in range(0, width+8, 8)]
            draw.line(points, fill=ink, width=3)
    elif kind == "confetti":
        for _ in range(max(1, w*h//3500)):
            x, y = rng.randrange(width), rng.randrange(height)
            draw.line((x, y, x+rng.randint(-16, 16), y+rng.randint(8, 24)), fill=rng.choice(list(colors.values())), width=6)
    else:
        # Small random colour fields, smoothed by the final downsample.
        for y in range(0, height, 4):
            for x in range(0, width, 4):
                draw.rectangle((x, y, x+3, y+3), fill=rng.choice(list(colors.values())))
    return _png(image.resize((w, h), Image.Resampling.LANCZOS))
