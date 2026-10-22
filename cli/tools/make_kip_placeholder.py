"""Write the PLACEHOLDER Kip sprite sheets the CLI ships until the mascot
work (feat/mascot, static/img/mascot/kip/) lands.

A Python port of the Kip rendition in the vault's "Kairos Mascot -
Concepts.html" (kipPixels), round body, no accessory, for the five states the
CLI uses plus idle. It writes the documented sheet format (see
kairos_cli/mascot.py): one PNG per theme, one row per state, 24 x 24 frames.

    python cli/tools/make_kip_placeholder.py
"""
import json
import math
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "kairos_cli" / "assets" / "kip-placeholder"
KN = 24
FRAMES = 16
STATES = ["idle", "thinking", "needs", "success", "error", "sleeping"]
TOKENS = {
    # parchment: Kip's body in ink, eyes in surface (the app's light theme)
    "default": {"ink": "#3A2A20", "surface": "#FBF6EE", "stage": "#F3EADB", "gold": "#B8893B",
                "goldHi": "#D9B260", "goldText": "#83601F", "danger": "#A8432F", "inkDim": "#6B5646",
                "inkFaint": "#7A6553"},
    # night: the concept sheet's own CLI rendition colours
    "night": {"ink": "#F3EADB", "surface": "#1F1814", "stage": "#1F1814", "gold": "#B8893B",
              "goldHi": "#D9B260", "goldText": "#D9B260", "danger": "#E08A78", "inkDim": "#C9B9A6",
              "inkFaint": "#9E8C7A"},
}


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def hexs(c):
    return "#%02X%02X%02X" % c


def mix(a, b, t):
    a, b = rgb(a), rgb(b)
    return hexs(tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)))


def lum(h):
    r, g, b = (v / 255 for v in rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def body_set():
    out = set()
    for y in range(KN):
        for x in range(KN):
            dx, dy = x + .5 - 11.5, y + .5 - 12.5
            inside = dx * dx + dy * dy <= 8.1 * 8.1
            nx, ny = x + .5 - 18, y + .5 - 5
            if nx * nx + ny * ny <= 3.5 * 3.5:
                inside = False
            if inside:
                out.add((x, y))
    return out


BODY = body_set()
Z4 = ["1111", "..1.", ".1..", "1111"]


def kip(state, f, T):
    P = {}

    def put(x, y, c):
        if 0 <= x < KN and 0 <= y < KN:
            P[(x, y)] = c
    body = T["ink"]
    dark = lum(body) < .2
    outline = mix(body, "#000000", .45) if dark else mix(body, "#3A2A20", .55)
    hi = mix(body, "#FFFFFF", .16 if dark else .38)
    eye = T["surface"]
    ox = oy = eye_dx = 0
    eyes, feet, pt, ptc, fx = "open", 0, (17, 4), T["gold"], []
    if state == "idle":
        if f % 40 in (37, 38) or f % 16 == 13:
            eyes = "blink"
        if 6 <= f % 16 < 10:
            eye_dx = 1
        if (f // 6) % 2:
            pt = (17, 3)
    elif state == "thinking":
        seq = [0, 0, 1, 1, 2, 2, 1, 1, 0, 0, -1, -1, -2, -2, -1, -1]
        ox = seq[f % 16]
        nxt = seq[(f + 1) % 16]
        eye_dx = (nxt > ox) - (nxt < ox) or ((seq[(f + 2) % 16] > ox) - (seq[(f + 2) % 16] < ox))
        feet = 1 if (f // 2) % 2 else 2
        a = -0.9 + (f % 12) * math.pi / 6
        pt = (round(11 + ox + 11 * math.cos(a)), round(12 + 11 * math.sin(a)))
    elif state == "success":
        seq = [0, 0, 1, -2, -3, -3, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        oy = seq[f % 16]
        eyes = "happy"
        if 3 <= f % 16 <= 7:
            for sx, sy in ((3, 3), (20, 11), (3, 15), (21, 1)):
                for a, b in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
                    fx.append((sx + a, sy + b, T["gold"]))
            ptc = T["goldHi"]
    elif state == "needs":
        eyes = "wide"
        if f % 16 in (12, 13):
            oy = -1
        if (f // 4) % 2:
            pt = None
            for y in (1, 2, 3, 5):
                fx.append((18, y, T["goldText"]))
    elif state == "error":
        eyes, pt, ptc = "worried", (17, 7), T["danger"]
        if f % 16 < 4:
            ox = [0, -1, 1, 0][f % 4]
        p = f % 12
        fx.append((19 + (1 if p > 6 else 0), 7 - p // 2, T["inkFaint"]))
        fx.append((20 - (1 if p > 6 else 0), 5 - p // 3, T["inkFaint"]))
    elif state == "sleeping":
        eyes, pt, ptc = "shut", (17, 7), mix(T["gold"], T["stage"], .5)
        p = f % 12
        zx, zy = 18 + p // 4, 7 - p
        for ry, row in enumerate(Z4):
            for rx, c in enumerate(row):
                if c == "1":
                    fx.append((zx + rx, zy + ry, T["inkDim"]))
    for (x, y) in BODY:
        edge = not ((x + 1, y) in BODY and (x - 1, y) in BODY and (x, y + 1) in BODY and (x, y - 1) in BODY)
        c = outline if edge else body
        if not edge and (x - 1, y) in BODY and (x, y - 1) in BODY and (x - 2, y - 2) not in BODY and x < 12 and y < 12:
            c = hi
        if state == "error" and edge and f % 16 < 2:
            c = T["danger"]
        put(x + ox, y + oy, c)
    fy = 21 + oy
    cols = {1: (7, 8, 14, 15), 2: (8, 9, 13, 14)}.get(feet, (8, 9, 14, 15))
    for x in cols:
        put(x + ox, fy, outline)
    EL, ER = (8 + ox + eye_dx, 11 + oy), (13 + ox + eye_dx, 11 + oy)
    for ex, ey in (EL, ER):
        if eyes == "open":
            for y in range(3):
                put(ex, ey + y, eye); put(ex + 1, ey + y, eye)
        elif eyes == "wide":
            for y in range(-1, 3):
                put(ex, ey + y, eye); put(ex + 1, ey + y, eye)
        elif eyes in ("blink", "shut"):
            put(ex, ey + 2, eye); put(ex + 1, ey + 2, eye)
        elif eyes == "happy":
            put(ex - 1, ey + 2, eye); put(ex, ey + 1, eye); put(ex + 1, ey + 1, eye); put(ex + 2, ey + 2, eye)
        elif eyes == "worried":
            for y in (1, 2):
                put(ex, ey + y, eye); put(ex + 1, ey + y, eye)
    if eyes == "worried":
        put(EL[0] + 1, EL[1] - 2, eye); put(EL[0], EL[1] - 1, eye)
        put(ER[0], ER[1] - 2, eye); put(ER[0] + 1, ER[1] - 1, eye)
    if pt:
        px, py = pt
        put(px, py, ptc); put(px + 1, py, ptc); put(px, py + 1, ptc)
        put(px + 1, py + 1, T["goldText"] if ptc == T["gold"] else ptc)
    for x, y, c in fx:
        put(x, y, c)
    return P


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sheets = {}
    for theme, T in TOKENS.items():
        image = Image.new("RGBA", (KN * FRAMES, KN * len(STATES)), (0, 0, 0, 0))
        for row, state in enumerate(STATES):
            for f in range(FRAMES):
                for (x, y), c in kip(state, f, T).items():
                    image.putpixel((f * KN + x, row * KN + y), rgb(c) + (255,))
        name = "kip.png" if theme == "default" else f"kip-{theme}.png"
        image.save(OUT / name)
        sheets[theme] = name
    manifest = {
        "format": "kairos-sprite-sheet", "version": 1, "name": "Kip", "placeholder": True,
        "frame": [KN, KN], "fps": 8, "sheets": sheets,
        "states": {state: {"row": i, "frames": FRAMES} for i, state in enumerate(STATES)},
    }
    (OUT / "kip.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
