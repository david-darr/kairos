"""Real images and palette treatments for every model, saved in the chat's own design."""
import hashlib
import html
import io
from pathlib import Path

from PIL import Image

from core import design_store, design_systems, design_tools, image_gen, image_providers, image_search, image_treatments
from core.tool_registry import ALL, EXTERNAL, WRITE, _object, _str, register
from core.untrusted import wrap_untrusted

NAMES = frozenset({"image_generate", "image_search", "image_treat", "image_pattern"})
NO_CONNECTION = ("No image generation is connected (Settings > Connections > Image generation). Use image_search for an openly licensed photo, "
                 "image_treat on the person's own photo, or image_pattern for a texture in the look.")
_ID = _str("Design id; optional when this chat has one design")
_SIZE = {"type": "string", "enum": ["square", "landscape", "portrait"]}


def _guard(handler):
    """Return useful plain text even when a downloaded picture cannot be decoded."""
    async def run(args, ctx):
        try:
            return await handler(args, ctx)
        except design_store.AccessError as error:
            return f"Not run: {error}"
        except (LookupError, ValueError) as error:
            text = str(error).strip("\'\"")
            return f"Not run: {text}"
        except (OSError, Image.DecompressionBombError):
            return "Not run: That picture could not be read. Choose another PNG, JPEG, GIF or WebP."
    run.__name__ = handler.__name__
    return run


def _design(args, ctx, optional=False):
    key = design_tools._key(ctx)
    if optional and not args.get("design_id") and (not key or not design_store.designs_for_chat(key)):
        return None
    return design_tools._design(args, ctx)


def _look(data):
    if data is None:
        return {}
    system = design_systems.get(data.get("design_system")) or design_systems.builtin()
    # The summary carries imagery; the full look also carries optional treatment defaults.
    look = design_systems.design_looks.get(system["id"]) or design_systems._style_look(system["id"])
    return look or system.get("look") or {}


def _save(raw, ext, data, alt="Describe this picture"):
    with Image.open(io.BytesIO(raw)) as source:
        if source.width * source.height > 40_000_000:
            raise ValueError("Choose a picture no larger than 40 megapixels.")
        if source.format not in ("PNG", "JPEG", "GIF", "WEBP"):
            raise ValueError("Choose a PNG, JPEG, GIF or WebP picture.")
        source.load()
        w, h = source.size
        # Generated servers may send JPEG or WebP even when the requested asset is PNG.
        if ext == "png" and source.format != "PNG":
            out = io.BytesIO()
            source.convert("RGBA" if "A" in source.getbands() else "RGB").save(out, "PNG")
            raw = out.getvalue()
    if data:
        asset = design_store.add_asset(data["id"], raw, ext)
        return asset, f'{asset} ({w}x{h}): use <img src="{asset}" alt="{html.escape(alt, quote=True)}">'
    folder = Path(image_gen.GENERATED_DIR)
    folder.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha256(raw).hexdigest() + "." + ext
    (folder / name).write_bytes(raw)
    return name, f"![Picture]({image_gen.GENERATED_URL_PREFIX}/{name}) ({w}x{h})"


@register("image_generate", ("Make real pictures (photos or illustrations) for a design with the person's own image connection. Describe the "
           "subject, setting, light, framing and mood; the look's picture style is added for you. Never ask for words in the "
           "picture: set text in HTML over it. Returns assets/... paths for <img src>. Without a connection it says so: then "
           "use image_search, image_treat or image_pattern. Never draw pictures or clip art in code instead."),
          _object({"prompt": _str("Describe the picture"), "size": _SIZE,
                   "count": {"type": "integer", "minimum": 1, "maximum": 4}, "design_id": _ID}, ("prompt",)),
          surfaces=ALL, effect=EXTERNAL)
@_guard
async def _generate(args, ctx):
    data = _design(args, ctx, optional=True)
    if not image_providers.provider_state()["configured"]:
        return NO_CONNECTION
    prompt = args.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Describe the picture you want.")
    prompt += ". Style: " + str(_look(data).get("imagery") or "natural photography") + ". No text, letters, logos or watermarks."
    images = await image_providers.generate(prompt, args.get("size", "square"), args.get("count", 1))
    lines = [_save(raw, "png", data)[1] for raw in images]
    return "\n".join(lines) + "\nWrite real alt text describing what each picture shows."


@register("image_search", ("Find openly licensed photos (Openverse, free, no key) for a design. First call with query to list choices; then "
           "call again with use set to the chosen photo id to save it into the design's assets. Every saved photo needs its "
           "credit line on the board in small type; the reply gives the exact text."),
          _object({"query": _str("Photo subject"), "count": {"type": "integer", "minimum": 1, "maximum": 8},
                   "orientation": _SIZE, "use": _str("Photo id from the search results"), "design_id": _ID}),
          surfaces=ALL, effect=EXTERNAL)
@_guard
async def _search(args, ctx):
    data = _design(args, ctx, optional=True)
    design_tools._taint(ctx)
    if args.get("use"):
        raw, ext, item = await image_search.fetch(args["use"])
        asset, line = _save(raw, ext, data)
        if data:
            design_store.add_credit(data["id"], asset, item)
        attribution = f"Photo: {item['title']} by {item['creator']}, {str(item['license']).upper()} {item['license_version']}".strip()
        return line + "\nCredit required: put this line on the board in small type: " + wrap_untrusted("photo credit", attribution)
    items = await image_search.search(args.get("query"), args.get("count", 6), args.get("orientation"))
    lines = [f"{i}. {item['id']}: {item['title']} by {item['creator']}, {item['license']} {item['license_version']}, "
             f"{item['width']}x{item['height']}, {item['landing']}" for i, item in enumerate(items, 1)]
    return wrap_untrusted("Openverse photo choices", "\n".join(lines) or "No matching photos. Try another search.")


@register("image_treat", ("Restyle the person's own photo in the design's colours (halftone, dither, duotone, grain or posterize; the look has "
           "a default). The source is an assets/<sha>.<ext> already in this design (the person uploads it on the canvas). "
           "Returns a new asset path."),
          _object({"source": _str("Asset path in this design"), "treatment": {"type": "string", "enum": list(image_treatments.TREATMENTS)},
                   "design_id": _ID}, ("source",)), surfaces=ALL, effect=WRITE)
@_guard
async def _treat(args, ctx):
    data = _design(args, ctx)
    source = args.get("source")
    if not isinstance(source, str) or not source.startswith("assets/"):
        raise ValueError("Use an assets/<sha>.<ext> photo from this design. Upload it on the canvas first.")
    path = design_store.asset_path(data["id"], source[len("assets/"):])
    raw = image_treatments.apply(path.read_bytes(), args.get("treatment") or _look(data).get("image_treatment") or "duotone", design_tools._tokens(data))
    return _save(raw, "png", data)[1]


@register("image_pattern", ("Make an abstract texture in the design's colours (dots, stripes, grid, waves, topo, confetti or noise; the look has "
           "a default) for backgrounds, covers and panels. Patterns never depict objects, icons or people. Returns an asset path."),
          _object({"kind": {"type": "string", "enum": list(image_treatments.PATTERNS)},
                   "size": {"type": "string", "enum": ["square", "landscape", "portrait", "wide"]},
                   "seed": {"type": "integer"}, "design_id": _ID}), surfaces=ALL, effect=WRITE)
@_guard
async def _pattern(args, ctx):
    data = _design(args, ctx)
    sizes = {"square": (1600, 1600), "landscape": (1600, 1000), "portrait": (1000, 1600), "wide": (1600, 500)}
    if args.get("size", "landscape") not in sizes:
        raise ValueError("Choose square, landscape, portrait or wide.")
    w, h = sizes[args.get("size", "landscape")]
    raw = image_treatments.pattern(args.get("kind") or _look(data).get("pattern") or "dots",
                                   design_tools._tokens(data), w, h, args.get("seed", 0))
    return _save(raw, "png", data)[1]
