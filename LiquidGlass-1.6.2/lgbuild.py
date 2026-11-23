#!/usr/bin/env python3
"""Build static, position-correct LiquidGlass materials without TeX shell escape.

Dependencies: Python 3.9+, Pillow, Poppler's pdftoppm, and a TeX installation.
TeX shell escape is disabled unless explicitly requested or opted into by local
project configuration. All intermediate files are isolated under build/. A
successful build retains only build/<job>.synctex.gz and publishes the PDF next
to its source; a failed build retains only build/<job>.log. Source images are
never changed.
SPDX-License-Identifier: MIT
"""
# Copyright (c) 2026 Ethan Lu and Liquidglass contributors
from __future__ import annotations

import argparse
from contextlib import contextmanager
from itertools import islice
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass

try:
    from PIL import Image, ImageChops, ImageCms, ImageEnhance, ImageFilter, ImageOps
except ImportError:
    raise SystemExit("LiquidGlass needs Pillow: python3 -m pip install Pillow")

VERSION = "1.6.2"
SP_PER_INCH = 65536 * 72.27
INPUT_LIMIT = 128 * 1024 * 1024
PIXEL_LIMIT = 120_000_000
EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp", ".gif", ".avif", ".heic", ".heif", ".ppm", ".tga", ".pdf"}
TEXT = {"light": (20, 38, 56), "dark": (244, 248, 255)}


class BuildError(RuntimeError):
    pass


@dataclass(frozen=True)
class Pane:
    fragment: int
    logical: int
    mode: str
    blur: float
    opacity: float
    grain: float
    refraction: float
    saturation: float
    contrast: float
    focusx: float
    focusy: float
    source: str
    state: str
    width: int
    height: int
    page: int = 0
    x: int = 0
    y: int = 0
    imagefit: str = "cover"
    sheen: float = 0.0
    sheensize: float = .75
    sheenx: float = .35
    sheeny: float = .22
    rolloff: float = 0.0
    mask: float = 0.0


def number(value, low, high, label):
    try:
        value = float(value)
    except (ValueError, TypeError) as exc:
        raise BuildError(f"{label} is not a number: {value}") from exc
    if not math.isfinite(value) or not low <= value <= high:
        raise BuildError(f"{label} must be between {low} and {high}")
    return value


def aux_files(root: Path) -> list[Path]:
    r"""Follow only literal, local auxiliary references produced by \include.

    TeX resolves auxiliary input names relative to the output directory.  Do not
    evaluate macros, absolute paths, or paths escaping that directory.
    """
    base = root.parent.resolve()
    visited, result = set(), []

    def visit(path):
        path = path.resolve()
        if path in visited or not path.is_file():
            return
        if not path.is_relative_to(base) or path.suffix != ".aux":
            return
        visited.add(path)
        result.append(path)
        content = path.read_text(encoding="utf-8", errors="replace")
        for name in re.findall(r"\\@input\{([^{}]+\.aux)\}", content):
            if any(c in name for c in "\\%#\r\n") or Path(name).is_absolute():
                continue
            visit(base / name)

    visit(root)
    return result


def prepare_output_directories(project: Path, output: Path):
    r"""Mirror source subdirectories needed by \include{chapters/one}."""
    for directory, subdirectories, filenames in os.walk(project):
        subdirectories[:] = [name for name in subdirectories if name not in {"build", ".liquidglass", ".git", ".hg", ".svn", "__pycache__"} and not name.startswith("liquidglass-backup")]
        if any(name.casefold().endswith(".tex") for name in filenames):
            (output / Path(directory).relative_to(project)).mkdir(parents=True, exist_ok=True)


def copy_references(source: Path, destination: Path, job: str):
    source = source.resolve()
    for path in aux_files(source / f"{job}.aux"):
        atomic_bytes(destination / path.relative_to(source), path.read_bytes())
    for suffix in (".toc", ".out", ".lof", ".lot", ".bbl", ".ind"):
        path = source / (job + suffix)
        if path.is_file():
            atomic_bytes(destination / path.name, path.read_bytes())
    for index in source.glob("*.ind"):
        if index.name != job + ".ind" and index.with_suffix(".idx").is_file():
            atomic_bytes(destination / index.name, index.read_bytes())


def parse_records(path: Path, aux: Path) -> list[Pane]:
    if not path.is_file() or not aux.is_file():
        raise BuildError(f"Missing geometry file: {path} or {aux}")
    positions = {}
    for aux_path in aux_files(aux):
        for line in aux_path.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.search(r"\\zref@newlabel\{lg-pos-(\d+)\}\{(.*)\}", line)
            if match:
                values = dict(re.findall(r"\\(posx|posy|abspage)\{(-?\d+)\}", match[2]))
                if all(key in values for key in ("posx", "posy", "abspage")):
                    positions[int(match[1])] = tuple(int(values[key]) for key in ("abspage", "posx", "posy"))
    result = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("LG|"):
            continue
        fields = line.strip().split("|")
        if len(fields) not in (16, 17, 18, 21, 22, 23, 24):
            raise BuildError(f"Invalid material record ({len(fields)} fields): {line[:180]}")
        _, fragment, logical, mode, blur, opacity, grain, refract, sat, contrast, fx, fy, source, state, width, height, *extra = fields
        # Accept older 16-field records as cover, plus one optional trailing delimiter.
        if extra and extra[-1] == "":
            extra.pop()
        if extra and (len(extra) not in (1, 5, 6, 7) or extra[0] not in {"cover", "stretch"}):
            raise BuildError("Image fit must be cover or stretch")
        imagefit = extra[0] if extra else "cover"
        sheen, sheensize, sheenx, sheeny = (0.0, .75, .35, .22)
        rolloff = number(extra[5], 0, 1, "highlight rolloff") if len(extra) >= 6 else 0.0
        mask = number(extra[6], 0, 1, "mask") if len(extra) == 7 else 0.0
        if len(extra) >= 5:
            sheen = number(extra[1], 0, 1, "sheen")
            sheensize = number(extra[2], .05, 2, "sheen size")
            sheenx = number(extra[3], 0, 1, "sheen x")
            sheeny = number(extra[4], 0, 1, "sheen y")
        if mode not in TEXT:
            raise BuildError(f"Unknown glass mode: {mode}")
        fid = int(fragment)
        if fid not in positions:
            raise BuildError(f"No saved page position for glass fragment {fid}; compile capture again")
        page, x, y = positions[fid]
        pane = Pane(fid, int(logical), mode,
                    number(blur, 0, 30, "blur"), number(opacity, 0, 1, "opacity"),
                    number(grain, 0, 1, "grain"), number(refract, 0, 10, "refraction"),
                    number(sat, 0, 3, "saturation"), number(contrast, 1, 21, "contrast"),
                    number(fx, 0, 1, "focus x"), number(fy, 0, 1, "focus y"),
                    source, state, int(width), int(height), page, x, y, imagefit,
                    sheen, sheensize, sheenx, sheeny, rolloff, mask)
        if pane.width <= 0 or pane.height <= 0 or pane.page <= 0:
            raise BuildError(f"Invalid geometry for glass fragment {fid}")
        result.append(pane)
    if len({p.fragment for p in result}) != len(result):
        raise BuildError("Duplicate glass fragment IDs")
    return result


def atomic_bytes(path: Path, data: bytes) -> bool:
    """Return True only when a file changed; a warm cache retains its mtime."""
    if path.is_file() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return True


def natural_key(path):
    return [int(s) if s.isdigit() else s.casefold() for s in re.split(r"(\d+)", str(path))]


def sources_for(panes, project: Path, package: Path):
    chosen, counters, logical_sources = {}, {}, {}
    for pane in panes:
        token = pane.source
        group = (pane.logical, token)
        if group in logical_sources:
            chosen[pane.fragment] = logical_sources[group]
            continue
        if token == "@page":
            selected = None
        elif token in {"@default", "@silver"}:
            selected = asset_directory(package) / {"@default": "default.png", "@silver": "frost-silver.png"}[token]
        elif token.startswith("@folder:") or token.startswith("@list:"):
            if token.startswith("@folder:"):
                directory = Path(token[8:]).expanduser()
                directory = directory if directory.is_absolute() else project / directory
                if not directory.is_dir():
                    raise BuildError(f"Background folder does not exist: {directory}")
                candidates = sorted((p for p in directory.iterdir() if p.is_file() and p.suffix.casefold() in EXTENSIONS), key=natural_key)
            else:
                candidates = [Path(p).expanduser() for p in token[6:].split(";") if p.strip()]
                candidates = [p if p.is_absolute() else project / p for p in candidates]
            if not candidates:
                raise BuildError(f"No supported images in {token}")
            index = counters.get(token, 0)
            selected = candidates[index % len(candidates)]
            counters[token] = index + 1
        else:
            selected = Path(token).expanduser()
            if not selected.is_absolute():
                selected = project / selected
        if selected is not None and not selected.is_file():
            raise BuildError(f"Background image does not exist: {selected}")
        logical_sources[group] = selected
        chosen[pane.fragment] = selected
    return chosen


def open_image(path: Path) -> Image.Image:
    if path.stat().st_size > INPUT_LIMIT:
        raise BuildError(f"Image exceeds 128 MiB: {path}")
    with path.open("rb") as stream:
        is_pdf = stream.read(5) == b"%PDF-"
    if is_pdf:
        with tempfile.TemporaryDirectory(prefix="liquidglass-pdf-") as temporary:
            prefix = Path(temporary) / "first-page"
            result = subprocess.run([find_tool("pdftoppm"), "-r", "144", "-f", "1", "-l", "1", "-singlefile", "-png", str(path), str(prefix)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode:
                raise BuildError(f"Cannot render PDF image {path}: " + result.stderr.decode(errors="replace"))
            return open_image(prefix.with_suffix(".png"))
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    with Image.open(path) as original:
        if original.width * original.height > PIXEL_LIMIT:
            raise BuildError(f"Image exceeds 120 megapixels: {path}")
        original.seek(0)
        image = ImageOps.exif_transpose(original)
        if image.mode.startswith("I;16"):
            image = image.convert("I").point(lambda n: n / 257).convert("L")
        elif image.mode == "I":
            low, high = image.getextrema()
            if 0 <= low <= high <= 65535:
                image = image.point(lambda n: n / 257).convert("L")
        elif image.mode == "F":
            low, high = image.getextrema()
            if not math.isfinite(low) or not math.isfinite(high):
                raise BuildError(f"Non-finite image samples: {path}")
            normalized = 0 <= low <= high <= 1
            scale = 255 if normalized else 255 / max(1e-8, high - low)
            offset = 0 if normalized else low
            image = image.point(lambda n: (n - offset) * scale).convert("L")
        alpha = image.convert("RGBA").getchannel("A") if "A" in image.getbands() or "transparency" in image.info else None
        profile = original.info.get("icc_profile")
        if profile:
            try:
                image = ImageCms.profileToProfile(image if image.mode in ("RGB", "CMYK", "LAB") else image.convert("RGB"), ImageCms.ImageCmsProfile(io.BytesIO(profile)), ImageCms.createProfile("sRGB"), outputMode="RGB")
            except (ValueError, OSError, ImageCms.PyCMSError):
                image = image.convert("RGB")
        else:
            image = image.convert("RGB")
        if alpha:
            image = Image.composite(image, Image.new("RGB", image.size, "white"), alpha)
        return image.copy()


def clamped_crop(image, box):
    """Crop with edge extension, preventing dark Gaussian halos at page edges."""
    left, top, right, bottom = map(int, box)
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        raise BuildError("Empty material crop")
    xs = max(0, min(image.width - 1, left))
    ys = max(0, min(image.height - 1, top))
    xe = max(xs + 1, min(image.width, right))
    ye = max(ys + 1, min(image.height, bottom))
    crop = image.crop((xs, ys, xe, ye))
    padl, padt = max(0, -left), max(0, -top)
    padr, padb = max(0, right - image.width), max(0, bottom - image.height)
    if not any((padl, padt, padr, padb)):
        return crop
    # Transform clamps all sample coordinates to the nearest source edge.
    output = Image.new("RGB", (width, height))
    output.paste(crop, (xs - left, ys - top))
    if padl:
        output.paste(crop.crop((0, 0, 1, crop.height)).resize((padl, crop.height)), (0, ys - top))
    if padr:
        output.paste(crop.crop((crop.width - 1, 0, crop.width, crop.height)).resize((padr, crop.height)), (width - padr, ys - top))
    if padt:
        output.paste(output.crop((0, ys - top, width, ys - top + 1)).resize((width, padt)), (0, 0))
    if padb:
        output.paste(output.crop((0, ye - top - 1, width, ye - top)).resize((width, padb)), (0, height - padb))
    return output


def lens(image, width, height, margin, radius, state):
    if radius <= 0:
        return image.crop((margin, margin, margin + width, margin + height))
    band = max(2, radius * 4)
    def warp(x, y):
        dx = radius * (math.exp(-max(0, x) / band) - math.exp(-max(0, width - x) / band))
        dy = 0
        if state in ("unbroken", "first"):
            dy += radius * math.exp(-max(0, y) / band)
        if state in ("unbroken", "last"):
            dy -= radius * math.exp(-max(0, height - y) / band)
        return margin + x + dx, margin + y + dy
    mesh = []
    step = max(8, min(32, int(band)))
    for y in range(0, height, step):
        for x in range(0, width, step):
            xr, yb = min(width, x + step), min(height, y + step)
            quad = (*warp(x, y), *warp(x, yb), *warp(xr, yb), *warp(xr, y))
            mesh.append(((x, y, xr, yb), quad))
    return image.transform((width, height), Image.Transform.MESH, mesh, Image.Resampling.BICUBIC)


LINEAR = [n / 255 / 12.92 if n / 255 <= .04045 else ((n / 255 + .055) / 1.055) ** 2.4 for n in range(256)]


def luminance(color):
    return .2126 * LINEAR[color[0]] + .7152 * LINEAR[color[1]] + .0722 * LINEAR[color[2]]


def min_contrast(image, mode):
    text = luminance(TEXT[mode])
    colours = image.getcolors(maxcolors=65536)
    values = (pixel for _, pixel in colours) if colours is not None else (image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata())
    def ratio(pixel):
        background = luminance(pixel)
        return (max(background, text) + .05) / (min(background, text) + .05)
    return min(ratio(pixel) for pixel in values)


def contrast_guard(image, pane):
    if pane.contrast <= 1:
        return image, min_contrast(image, pane.mode), 0.0
    maximum = (1.05 / (luminance(TEXT[pane.mode]) + .05) if pane.mode == "light" else (luminance(TEXT[pane.mode]) + .05) / .05)
    if pane.contrast > maximum + 1e-6:
        raise BuildError(f"Requested contrast {pane.contrast:g}:1 is impossible with {pane.mode} text (maximum {maximum:.2f}:1)")
    before = min_contrast(image, pane.mode)
    if before + .005 >= pane.contrast:
        return image, before, 0.0
    # A conservative channel bound guarantees every pixel passes, including
    # saturated photographs.  The final report also measures actual luminance.
    required = pane.contrast * (luminance(TEXT["light"]) + .05) - .05 if pane.mode == "light" else (luminance(TEXT["dark"]) + .05) / pane.contrast - .05
    target = next((i for i, value in enumerate(LINEAR) if value >= required), 255)
    extrema = image.getextrema()
    if pane.mode == "light":
        lowest = min(pair[0] for pair in extrema)
        blend = max(0, (target - lowest) / max(1, 255 - lowest))
        table = [min(255, math.ceil(n + (255 - n) * blend)) for n in range(256)]
    else:
        target = max(0, target - 1)
        highest = max(pair[1] for pair in extrema)
        blend = max(0, 1 - target / max(1, highest))
        table = [max(0, math.floor(n * (1 - blend))) for n in range(256)]
    image = image.point(table * 3)
    return image, min_contrast(image, pane.mode), blend


def sheen_field(image, pane, geometry=None):
    """Add one broad light field in logical-box coordinates, never per page.

    The scalar field is separable, so only two one-dimensional masks need
    Python work. Pillow performs the raster multiplication/compositing in C.
    Geometry is (logical width, logical height, fragment left, fragment top).
    """
    if pane.sheen <= 0:
        return image
    logical_width, logical_height, left, top = geometry or (*image.size, 0, 0)
    sigma = max(1.0, pane.sheensize * min(logical_width, logical_height))
    centre_x, centre_y = pane.sheenx * logical_width, pane.sheeny * logical_height
    horizontal = bytes(round(255 * pane.sheen * math.exp(-.5 * ((left + x + .5 - centre_x) / sigma) ** 2))
                       for x in range(image.width))
    vertical = bytes(round(255 * math.exp(-.5 * ((top + y + .5 - centre_y) / sigma) ** 2))
                     for y in range(image.height))
    mask_x = Image.frombytes("L", (image.width, 1), horizontal).resize(image.size)
    mask_y = Image.frombytes("L", (1, image.height), vertical).resize(image.size)
    mask = ImageChops.multiply(mask_x, mask_y)
    # Dark glass reflects a subdued cool light instead of a white spot that
    # would then force the contrast guard to darken the entire material.
    colour = (255, 255, 255) if pane.mode == "light" else (100, 137, 158)
    return Image.composite(Image.new("RGB", image.size, colour), image, mask)


def material(source, pane, width, height, margin, dpi, sheen_geometry=None):
    sigma = pane.blur * dpi / 25.4
    image = source.filter(ImageFilter.GaussianBlur(sigma)) if sigma else source.copy()
    image = lens(image, width, height, margin, pane.refraction * dpi / 25.4, pane.state)
    image = ImageEnhance.Color(image).enhance(pane.saturation)
    tint = (246, 250, 255) if pane.mode == "light" else (12, 24, 40)
    image = Image.blend(image, Image.new("RGB", image.size, tint), pane.opacity)
    if pane.mask:
        # The veil follows the logical pane, so it never restarts at a page cut.
        full_width, full_height, left, top = sheen_geometry or (*image.size, 0, 0)
        horizontal = bytes(round(255 * pane.mask * (.20 + .55 * (left + x + .5) / full_width))
                           for x in range(width))
        vertical = bytes(round(255 * pane.mask * .25 * (top + y + .5) / full_height)
                         for y in range(height))
        veil_x = Image.frombytes("L", (width, 1), horizontal).resize(image.size)
        veil_y = Image.frombytes("L", (1, height), vertical).resize(image.size)
        image = Image.composite(Image.new("RGB", image.size, tint), image, ImageChops.add(veil_x, veil_y))
    image = sheen_field(image, pane, sheen_geometry)
    if pane.rolloff and pane.mode == "light":
        table = [round(level - pane.rolloff * drop * (max(0, level - 128) / 127) ** 2)
                 for drop in (55, 48, 43) for level in range(256)]
        image = image.point(table)
    if pane.grain:
        grain_identity = asdict(pane)
        # Preserve old noise exactly when the new effect is off; turning a
        # lighting control also need not randomize the fine grain pattern.
        for key in ("sheen", "sheensize", "sheenx", "sheeny", "rolloff", "mask"):
            grain_identity.pop(key)
        seed = int(hashlib.sha256(source.tobytes() + json.dumps(grain_identity, sort_keys=True).encode()).hexdigest()[:16], 16)
        rng = random.Random(seed)
        noise = Image.frombytes("L", image.size, rng.randbytes(width * height) if hasattr(rng, "randbytes") else bytes(rng.randrange(256) for _ in range(width * height)))
        noise = Image.merge("RGB", (noise, noise, noise))
        image = Image.blend(image, noise, pane.grain)
    image, measured, extra = contrast_guard(image, pane)
    return image, measured, extra


def find_tool(name):
    executable = shutil.which(name)
    if not executable and sys.platform == "darwin":
        for directory in ("/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin"):
            candidate = Path(directory) / name
            if candidate.is_file():
                executable = str(candidate)
                break
    if not executable:
        raise BuildError(f"Required program '{name}' was not found on PATH")
    return executable


def asset_directory(package: Path) -> Path:
    """Find resources in a local copy, browsable release, or TDS installation."""
    candidates = [package / "liquidglass-assets", package / "assets"]
    if os.environ.get("LIQUIDGLASS_ASSETS"):
        candidates.insert(0, Path(os.environ["LIQUIDGLASS_ASSETS"]).expanduser())
    kpse = shutil.which("kpsewhich")
    if not kpse and sys.platform == "darwin":
        candidate = Path("/Library/TeX/texbin/kpsewhich")
        kpse = str(candidate) if candidate.is_file() else None
    if kpse:
        result = subprocess.run([kpse, "liquidglass.sty"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode == 0 and result.stdout.strip():
            candidates.append(Path(os.fsdecode(result.stdout.strip())).parent / "liquidglass-assets")
    for candidate in candidates:
        if (candidate / "default.png").is_file():
            return candidate.resolve()
    raise BuildError("Missing liquidglass-assets folder. Keep it beside liquidglass.sty and lgbuild.py, or install the complete TDS archive")


def compile_environment(package: Path):
    env = os.environ.copy()
    if (package / "liquidglass.sty").is_file():
        # The trailing separator retains the normal TeX search path.
        env["TEXINPUTS"] = str(package) + os.pathsep + env.get("TEXINPUTS", "")
    return env


def run_compile(engine, main, job, output, capture, console_file, env=None, shell_escape=False):
    output.mkdir(parents=True, exist_ok=True)
    map_path = (output / (job + ".lgi.tex")).resolve().as_posix()
    expression = (r"\def\LiquidGlassCapture{1}" if capture else "")
    expression += r"\edef\LiquidGlassMapFile{\detokenize{" + map_path + "}}"
    # Index tools run outside TeX, from the correct staging directory. This also
    # prevents imakeidx's automatic shell command from writing into the project.
    expression += r"\PassOptionsToPackage{noautomatic}{imakeidx}"
    expression += r"\input{" + main.name + "}"
    args = [engine, "-interaction=nonstopmode", "-halt-on-error", "-file-line-error",
            "-synctex=1", "-recorder", "-shell-escape" if shell_escape else "-no-shell-escape",
            f"-jobname={job}", f"-output-directory={output}", expression]
    process_env = dict(env or os.environ)
    # Both old styles and other normal TeX inputs see the staged map before any
    # legacy .lgi.tex in the source directory. New styles use the explicit macro.
    process_env["TEXINPUTS"] = str(output) + os.pathsep + process_env.get("TEXINPUTS", "")
    completed = subprocess.run(args, cwd=main.parent, env=process_env,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    atomic_bytes(console_file, completed.stdout)
    if completed.returncode:
        tail = completed.stdout.decode("utf-8", errors="replace").splitlines()[-24:]
        raise BuildError("TeX compilation failed:\n" + "\n".join(tail))


def run_auxiliary_tools(output: Path, project: Path, job: str, state: dict, bibliography="auto", index="auto", env=None):
    """Run the ordinary book tools outside TeX, when their inputs change."""
    changed = False

    def execute(name, arguments, key, inputs, working_directory=None, process_env=None):
        nonlocal changed
        digest = hashlib.sha256()
        for path in inputs:
            if path.is_file():
                digest.update(path.read_bytes())
        signature = digest.hexdigest()
        if state.get(key) == signature:
            return
        result = subprocess.run([find_tool(name), *arguments], cwd=working_directory or project, env=process_env or env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        atomic_bytes(output / (key + ".console.txt"), result.stdout)
        if result.returncode:
            tail = result.stdout.decode("utf-8", errors="replace").splitlines()[-18:]
            raise BuildError(name + " failed:\n" + "\n".join(tail))
        state[key] = signature
        changed = True

    aux = output / (job + ".aux")
    aux_text = aux.read_text(encoding="utf-8", errors="replace") if aux.is_file() else ""
    bcf = output / (job + ".bcf")
    if bibliography == "auto" and bcf.is_file() and "abx@aux@" in aux_text:
        inputs = [bcf]
        try:
            for element in ET.parse(bcf).iter():
                if element.tag.rsplit("}", 1)[-1] == "datasource" and element.text:
                    path = Path(element.text.strip())
                    inputs.append(path if path.is_absolute() else project / path)
        except ET.ParseError as exc:
            raise BuildError("Incomplete bibliography control file; check the TeX log") from exc
        # Relative paths avoid Perl/PAR double-encoding of non-ASCII absolute
        # directory arguments on some macOS Biber installations.
        bib_env = dict(env or os.environ)
        bib_env["BIBINPUTS"] = os.path.relpath(project, output) + os.pathsep + bib_env.get("BIBINPUTS", "")
        execute("biber", [job], "biber", inputs, output, bib_env)
    elif bibliography == "auto" and "\\bibdata{" in aux_text:
        inputs = [aux]
        for names in re.findall(r"\\bibdata\{([^}]+)\}", aux_text):
            inputs.extend(project / (name.strip() + ".bib") for name in names.split(","))
        # BibTeX runs in the output directory; BIBINPUTS still sees the project.
        bib_env = dict(env or os.environ)
        bib_env["BIBINPUTS"] = str(project) + os.pathsep + bib_env.get("BIBINPUTS", "")
        signature = hashlib.sha256(b"".join(p.read_bytes() for p in inputs if p.is_file())).hexdigest()
        if state.get("bibtex") != signature:
            result = subprocess.run([find_tool("bibtex"), job], cwd=output, env=bib_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            atomic_bytes(output / "bibtex.console.txt", result.stdout)
            if result.returncode:
                raise BuildError("BibTeX failed; see " + str(output / "bibtex.console.txt"))
            state["bibtex"] = signature
            changed = True
    if index == "auto":
        log = output / (job + ".log")
        log_text = log.read_text(encoding="utf-8", errors="replace") if log.is_file() else ""
        for idx in output.glob("*.idx"):
            if idx.stat().st_size and (idx.name in log_text or "imakeidx" in log_text):
                execute("makeindex", ["-o", idx.with_suffix(".ind").name, idx.name], "makeindex-" + idx.stem, [idx], output)
    return changed


def render_pages(pdf, panes, directory, dpi):
    if not panes:
        return {}
    tool = find_tool("pdftoppm")
    result = {}
    for page in sorted({p.page for p in panes}):
        prefix = directory / f"backdrop-{page}"
        completed = subprocess.run([tool, "-hide-annotations", "-r", str(dpi), "-f", str(page), "-l", str(page), "-singlefile", "-png", str(pdf), str(prefix)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if completed.returncode:
            raise BuildError("PDF backdrop rendering failed: " + completed.stderr.decode(errors="replace"))
        with Image.open(prefix.with_suffix(".png")) as image:
            result[page] = image.convert("RGB")
    return result


def generate(panes, capture_pdf, project, directory, dpi, package):
    selected = sources_for(panes, project, package)
    page_images = render_pages(capture_pdf, [p for p in panes if selected[p.fragment] is None], directory, dpi)
    pixel_factor = dpi / SP_PER_INCH
    groups = {}
    for pane in panes:
        groups.setdefault((pane.logical, str(selected[pane.fragment])), []).append(pane)
    image_canvases, offsets, sheen_geometry = {}, {}, {}
    for key, group in groups.items():
        source_path = selected[group[0].fragment]
        width = max(1, round(max(p.width for p in group) * pixel_factor))
        heights = [max(1, round(p.height * pixel_factor)) for p in group]
        total = sum(heights)
        if source_path is not None and width * total > 24_000_000:
            raise BuildError("A logical glass box exceeds 24 million output pixels; reduce --dpi or split the box")
        offset = 0
        for pane, height in zip(group, heights):
            fragment_width = max(1, round(pane.width * pixel_factor))
            left = round((width - fragment_width) * pane.focusx)
            offsets[pane.fragment] = offset
            sheen_geometry[pane.fragment] = (width, total, left, offset)
            offset += height
        if source_path is None:
            continue
        image = open_image(source_path)
        if group[0].imagefit == "stretch":
            # Keep the complete texture once per logical box, including long boxes.
            canvas = image.resize((width, total), Image.Resampling.LANCZOS)
        else:
            canvas = ImageOps.fit(image, (width, total), Image.Resampling.LANCZOS, centering=(group[0].focusx, group[0].focusy))
        image_canvases[key] = canvas
    report, mapping, changed = [], [], 0
    index_file = directory / "render-cache.json"
    try:
        old_index = json.loads(index_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        old_index = {}
    index = {}
    renderer_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    for pane in panes:
        width = max(1, round(pane.width * pixel_factor))
        height = max(1, round(pane.height * pixel_factor))
        if width * height > 24_000_000:
            raise BuildError(f"Glass fragment {pane.fragment} exceeds 24 million output pixels")
        margin = math.ceil((pane.blur * 4 + pane.refraction * 5) * dpi / 25.4) + 3
        path = selected[pane.fragment]
        if path is None:
            page = page_images[pane.page]
            left = round(pane.x * pixel_factor)
            top = round(page.height - (pane.y + pane.height) * pixel_factor)
            box = (left - margin, top - margin, left + width + margin, top + height + margin)
            source = clamped_crop(page, box)
            source_name = "@page"
        else:
            canvas = image_canvases[(pane.logical, str(path))]
            left = round((canvas.width - width) * pane.focusx)
            top = offsets[pane.fragment]
            source = clamped_crop(canvas, (left - margin, top - margin, left + width + margin, top + height + margin))
            source_name = str(path.resolve())
        target = directory / f"pane-{pane.fragment}.png"
        input_hash = hashlib.sha256(source.tobytes() + json.dumps({"pane": asdict(pane), "dpi": dpi, "renderer": renderer_hash,
                                                                "sheen_geometry": sheen_geometry[pane.fragment]}, sort_keys=True).encode()).hexdigest()
        previous = old_index.get(str(pane.fragment), {})
        cached = False
        if previous.get("input_hash") == input_hash and target.is_file():
            data = target.read_bytes()
            if hashlib.sha256(data).hexdigest() == previous.get("sha256"):
                try:
                    with Image.open(io.BytesIO(data)) as test_image:
                        cached = test_image.size == (width, height)
                        test_image.verify()
                except (OSError, ValueError):
                    cached = False
        if cached:
            ratio, adaptive = previous["contrast_min"], previous["adaptive_tint"]
        else:
            image, ratio, adaptive = material(source, pane, width, height, margin, dpi,
                                               sheen_geometry[pane.fragment])
            stream = io.BytesIO()
            image.save(stream, format="PNG", compress_level=6)
            data = stream.getvalue()
            changed += atomic_bytes(target, data)
        digest = hashlib.sha256(data).hexdigest()
        index[str(pane.fragment)] = {"input_hash": input_hash, "sha256": digest, "contrast_min": ratio, "adaptive_tint": adaptive}
        relative = target.relative_to(project).as_posix()
        mapping.extend([
            rf"\expandafter\gdef\csname lg@file@{pane.fragment}\endcsname{{\detokenize{{{relative}}}}}",
            rf"\expandafter\gdef\csname lg@width@{pane.fragment}\endcsname{{{pane.width}}}",
            rf"\expandafter\gdef\csname lg@height@{pane.fragment}\endcsname{{{pane.height}}}",
        ])
        report.append({**asdict(pane), "resolved_source": source_name, "pixels": [width, height], "contrast_min": round(ratio, 4), "adaptive_tint": round(adaptive, 5), "sha256": digest, "file": relative, "cache_hit": cached})
    atomic_bytes(index_file, (json.dumps(index, sort_keys=True, indent=2) + "\n").encode())
    return report, "\n".join(mapping) + "\n", changed


ENGINES = {"lualatex", "xelatex", "pdflatex"}


def project_options(main: Path):
    """Read an explicit, local project configuration; never infer shell access."""
    path = main.parent / "liquidglass.json"
    if not path.exists():
        return {}, {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise BuildError(f"Cannot read {path.name}: {exc}") from exc
    if not isinstance(data, dict):
        raise BuildError("liquidglass.json must contain a JSON object")
    unknown = set(data) - {"engine", "shell_escape", "documents"}
    if unknown:
        raise BuildError("Unknown liquidglass.json setting: " + ", ".join(sorted(unknown)))
    documents = data.get("documents", {})
    if not isinstance(documents, dict):
        raise BuildError("liquidglass.json documents must be an object keyed by .tex filename")
    settings = {key: value for key, value in data.items() if key != "documents"}
    for name, values in documents.items():
        if not isinstance(name, str) or not name.casefold().endswith(".tex") or not isinstance(values, dict):
            raise BuildError("Every liquidglass.json document entry must map a .tex filename to an object")
        if set(values) - {"engine", "shell_escape"}:
            raise BuildError("Document settings accept only engine and shell_escape")
        validate_options(values)
    validate_options(settings)
    return settings, documents.get(main.name, {})


def validate_options(settings):
    if "engine" in settings and (not isinstance(settings["engine"], str) or settings["engine"] not in ENGINES):
        raise BuildError("Configured engine must be lualatex, xelatex or pdflatex")
    if "shell_escape" in settings and not isinstance(settings["shell_escape"], bool):
        raise BuildError("Configured shell_escape must be true or false")


def resolve_options(main, args):
    settings, document_settings = project_options(main)
    engine = getattr(args, "engine", "auto")
    if engine == "auto":
        engine = document_settings.get("engine")
        if engine is None:
            with main.open(encoding="utf-8-sig", errors="replace") as source:
                header = "".join(islice(source, 50))
            magic = re.search(r"(?im)^\s*%\s*!\s*tex\s+program\s*=\s*(lualatex|xelatex|pdflatex)\b", header)
            engine = magic.group(1).lower() if magic else settings.get("engine", "lualatex")
    if engine not in ENGINES:
        raise BuildError("Engine must be auto, lualatex, xelatex or pdflatex")
    shell_escape = getattr(args, "shell_escape", None)
    if shell_escape is None:
        shell_escape = document_settings.get("shell_escape", settings.get("shell_escape", False))
    return engine, shell_escape


@contextmanager
def job_lock(build_directory, main):
    """Refuse overlapping builds of one source without touching an active job."""
    main = main.resolve()
    identifier = hashlib.sha256(str(main).encode("utf-8")).hexdigest()[:20]
    path = build_directory / (".liquidglass-" + identifier + ".lock")
    token = os.urandom(16).hex()
    payload = json.dumps({"pid": os.getpid(), "source": str(main), "token": token})
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise BuildError("Another build holds this document's lock. Wait for it to finish. "
                         f"If it was interrupted and is no longer running, remove {path}") from exc
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(payload)
        yield
    finally:
        try:
            if path.read_text(encoding="utf-8") == payload:
                path.unlink()
        except FileNotFoundError:
            pass


def sync_data(final, project, job):
    """Retain a self-contained SyncTeX index with normalized source locations."""
    path = final / (job + ".synctex.gz")
    if not path.is_file():
        raise BuildError("The engine did not produce the requested SyncTeX file")
    text = gzip.decompress(path.read_bytes()).decode("utf-8", errors="replace")
    lines = []
    for line in text.splitlines(keepends=True):
        if line.startswith("Input:"):
            fields = line.rstrip("\r\n").split(":", 2)
            if len(fields) == 3:
                source = Path(fields[2])
                if not source.is_absolute():
                    local = project / source
                    if local.exists():
                        line = fields[0] + ":" + fields[1] + ":" + str(local.resolve()) + "\n"
        lines.append(line)
    return gzip.compress("".join(lines).encode("utf-8"), mtime=0)


def failed_log(workspace, job, error):
    """Consolidate errors into the sole retained failure artifact."""
    sections = [f"LiquidGlass {VERSION} build failed\n{error}\n"]
    logs = sorted(workspace.rglob(job + ".log"), key=lambda p: p.stat().st_mtime_ns)
    if logs:
        sections.append("\n--- Last TeX log ---\n" + logs[-1].read_text(encoding="utf-8", errors="replace"))
    for path in sorted(workspace.rglob("*.console.txt")):
        sections.append("\n--- " + path.relative_to(workspace).as_posix() + " ---\n" +
                        path.read_text(encoding="utf-8", errors="replace"))
    return "".join(sections).encode("utf-8")


def log_diagnostics(path):
    """Expose warning counts to a caller without retaining successful logs."""
    text = path.read_text(encoding="utf-8", errors="replace")
    return {
        "overfull": len(re.findall(r"Overfull \\[hv]box", text)),
        "underfull": len(re.findall(r"Underfull \\[hv]box", text)),
        "missing_characters": text.count("Missing character:"),
        "undefined_reference_warnings": len(re.findall(r"Warning: Reference\b", text)),
        "undefined_citation_warnings": len(re.findall(r"Warning: Citation\b", text)),
        "undefined_notices": len(re.findall(r"\bundefined\b", text)),
    }


def staged_build(args, main, workspace):
    project, job = main.parent, main.stem
    capture, final, materials = workspace / "capture", workspace / "final", workspace / "materials"
    capture.mkdir(); final.mkdir(); materials.mkdir()
    prepare_output_directories(project, capture)
    prepare_output_directories(project, final)
    atomic_bytes(capture / (job + ".aux"), b"\\relax\n")
    atomic_bytes(capture / (job + ".lgi.tex"), b"% Capture has no foreground materials.\n")
    engine_name, shell_escape = resolve_options(main, args)
    engine = find_tool(engine_name)
    package = Path(__file__).resolve().parent
    env = compile_environment(package)
    bibliography = getattr(args, "bibliography", "auto")
    index = getattr(args, "index", "auto")
    auxiliary_state = {}
    print(f"LiquidGlass {VERSION}: capturing {main.name} ({engine_name}, shell escape {'enabled' if shell_escape else 'disabled'})", flush=True)
    for attempt in range(1, 4):
        previous = None
        for capture_pass in range(6):
            run_compile(engine, main, job, capture, True,
                        workspace / f"capture-{capture_pass + 1}.console.txt", env, shell_escape)
            tools_changed = run_auxiliary_tools(capture, project, job, auxiliary_state,
                                                bibliography, index, env)
            panes = parse_records(capture / f"{job}.lgr", capture / f"{job}.aux")
            if previous == panes and not tools_changed:
                break
            previous = panes
        else:
            raise BuildError("Capture geometry did not stabilize after six passes")
        print(f"Rendering {len(panes)} pane fragments at {args.dpi} dpi", flush=True)
        report, mapping, changed = generate(panes, capture / f"{job}.pdf", project,
                                            materials, args.dpi, package)
        atomic_bytes(final / f"{job}.lgi.tex", mapping.encode("utf-8"))
        copy_references(capture, final, job)
        run_compile(engine, main, job, final, False, workspace / "final.console.txt", env, shell_escape)
        final_records = parse_records(final / f"{job}.lgr", final / f"{job}.aux")
        if panes == final_records:
            payload = {"version": VERSION, "engine": engine_name, "dpi": args.dpi,
                       "document": main.name, "stable": True, "attempts": attempt,
                       "panes": report, "generated": changed, "reused": len(panes) - changed,
                       "shell_escape": shell_escape, "auxiliary_tools": sorted(auxiliary_state),
                       "diagnostics": log_diagnostics(final / (job + ".log"))}
            return final, payload
        copy_references(final, capture, job)
        print("Layout changed during final composition; recapturing positions", flush=True)
    raise BuildError("Final layout did not stabilize after three material builds; inspect floats or conditional capture content")


def build(args):
    main = args.document.expanduser().resolve()
    if not main.is_file() or main.suffix.casefold() != ".tex":
        raise BuildError(f"Expected an existing .tex document: {main}")
    if any(character in main.name for character in "{}%#\\\n\r"):
        raise BuildError("The main TeX filename cannot contain braces, percent/hash signs, backslashes, or newlines")
    if not 72 <= args.dpi <= 300:
        raise BuildError("--dpi must be 72..300")
    project, job = main.parent, main.stem
    build_directory = project / "build"
    build_directory.mkdir(parents=True, exist_ok=True)
    # The lock sits outside the temporary directory so a competing call cannot
    # enter the job or remove another running call's results.
    with job_lock(build_directory, main):
        short_job = hashlib.sha256(job.encode("utf-8")).hexdigest()[:12]
        workspace = Path(tempfile.mkdtemp(prefix=".liquidglass-" + short_job + "-", dir=build_directory))
        try:
            final, payload = staged_build(args, main, workspace)
            synchronization = sync_data(final, project, job)
            atomic_bytes(build_directory / (job + ".synctex.gz"), synchronization)
            atomic_bytes(project / (job + ".pdf"), (final / (job + ".pdf")).read_bytes())
            (build_directory / (job + ".log")).unlink(missing_ok=True)
            payload["pdf"] = str(project / (job + ".pdf"))
            payload["synctex"] = str(build_directory / (job + ".synctex.gz"))
            print(f"Ready: {project / (job + '.pdf')} ({len(payload['panes'])} fragments; "
                  f"SyncTeX: build/{job}.synctex.gz)", flush=True)
            return payload
        except BaseException as exc:
            (build_directory / (job + ".synctex.gz")).unlink(missing_ok=True)
            log = build_directory / (job + ".log")
            atomic_bytes(log, failed_log(workspace, job, exc))
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            raise BuildError(f"{exc}\nFull log: {log}") from exc
        finally:
            shutil.rmtree(workspace, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", type=Path, help="Main .tex file")
    parser.add_argument("--engine", choices=("auto", "lualatex", "xelatex", "pdflatex"), default="auto",
                        help="Engine: CLI > per-document setting > TeX program directive > global setting > lualatex")
    parser.add_argument("--dpi", type=int, default=144, help="Material resolution, 72..300 (default 144)")
    parser.add_argument("--bibliography", choices=("auto", "none"), default="auto", help="Run Biber/BibTeX for standard bibliography data (default auto)")
    parser.add_argument("--index", choices=("auto", "none"), default="auto", help="Run MakeIndex for standard index files (default auto)")
    external = parser.add_mutually_exclusive_group()
    external.add_argument("--shell-escape", dest="shell_escape", action="store_true", help="Explicitly allow external TeX commands required by this document")
    external.add_argument("--no-shell-escape", dest="shell_escape", action="store_false", help="Disable external TeX commands, overriding project configuration")
    parser.set_defaults(shell_escape=None)
    args = parser.parse_args()
    if not 72 <= args.dpi <= 300:
        parser.error("--dpi must be 72..300")
    try:
        build(args)
    except (BuildError, OSError, ValueError) as exc:
        parser.exit(1, f"LiquidGlass: {exc}\n")


if __name__ == "__main__":
    main()
