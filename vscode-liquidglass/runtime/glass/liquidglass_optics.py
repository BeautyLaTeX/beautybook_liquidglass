"""Shape-aware Float32 CPU materials for the LiquidGlass PDF compositor."""

from dataclasses import dataclass, replace

import numpy as np
from PIL import Image


@dataclass(frozen=True)
class Profile:
    rim_mm: float
    max_slope: float
    depth_scale: float
    reflection: float
    shade: float
    rim_sharpness: float


PROFILES = {
    "regular": Profile(3.2, 1.17, 3.8, .14, .07, .60),
    "clear": Profile(4.4, 2.0, 6.0, .22, .13, 1.0),
    "reading": Profile(2.6, .95, 3.2, .13, .055, .44),
    "reading-lens": Profile(2.0, 2.0, 6.0, .22, 0, 1.0),
}
IOR = 1.49
BASE_REFLECTION = ((IOR - 1) / (IOR + 1)) ** 2
TILE_SIZE = 768
SP_PER_INCH = 65536 * 72.27
DARK_WINDOW = "reading-window-dark"
CODE_WINDOW = "reading-window-code"
FROST_WINDOWS = {DARK_WINDOW, CODE_WINDOW}
FROST_INK = (18, 18, 18)
# Reference colour that sets the approved glass exposure. The native minted
# palette is rendered independently and can include colours below this luminance.
FROST_CODE_REFERENCE = (234, 224, 255)
PROFILES[DARK_WINDOW] = Profile(2.3, 1.05, 3.3, .035, .025, .12)
PROFILES[CODE_WINDOW] = PROFILES[DARK_WINDOW]


def to_linear(srgb):
    srgb = np.asarray(srgb, dtype=np.float32)
    return np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4)


SRGB_LUT = to_linear(np.arange(256, dtype=np.float32) / 255)


def to_srgb(linear):
    linear = np.clip(linear, 0, 1)
    return np.where(linear <= .0031308, 12.92 * linear, 1.055 * linear ** (1 / 2.4) - .055)


def to_srgb_byte(linear):
    return np.rint(to_srgb(linear) * 255).astype(np.uint8)


def frost_scales(pane):
    """Physical radii for the base diffusion and the softer bloom."""
    fine = max(8.0, pane.blur)
    return fine, min(1.8 * fine, max(18.0, fine))


def sampling_halo(pane, dpi, profile):
    depth = PROFILES[profile].depth_scale
    refraction = min(1.4, 7 * pane.refraction) if profile == "reading-lens" else pane.refraction
    sigma = frost_scales(pane)[1] if profile in FROST_WINDOWS else pane.blur
    return int(np.ceil((3.5 * sigma + .65 * depth * refraction) * dpi / 25.4)) + 3


def round_contour(x, y, width, height, radii):
    """Signed distance and outward normals for four independent rounded corners."""
    x, y = x - width / 2, y - height / 2
    nw, ne, sw, se = radii
    radius = np.where(y < 0, np.where(x < 0, nw, ne), np.where(x < 0, sw, se)).astype(np.float32)
    qx, qy = np.abs(x) - width / 2 + radius, np.abs(y) - height / 2 + radius
    cx, cy = np.maximum(qx, 0), np.maximum(qy, 0)
    length = np.hypot(cx, cy)
    distance = length + np.minimum(np.maximum(qx, qy), 0) - radius
    safe_length = np.maximum(length, 1e-6)
    nx = np.where(length > 0, cx / safe_length, qx >= qy) * np.sign(x)
    ny = np.where(length > 0, cy / safe_length, qy > qx) * np.sign(y)
    return distance, nx, ny


def notched_contour(x, y, width, height, radii):
    """Beautybook's ys outline is a rectangle with concave circular cutouts."""
    qx, qy = np.maximum(-x, x - width), np.maximum(-y, y - height)
    distance = np.maximum(qx, qy)
    nx = np.where(qx >= qy, np.sign(x - width / 2), 0)
    ny = np.where(qy > qx, np.sign(y - height / 2), 0)
    for (cx, cy), radius in zip(((0, 0), (width, 0), (0, height), (width, height)), radii):
        if radius:
            dx, dy = x - cx, y - cy
            length = np.hypot(dx, dy)
            cutout = radius - length
            nearer = cutout > distance
            scale = -1 / np.maximum(length, 1e-6)
            nx, ny = np.where(nearer, dx * scale, nx), np.where(nearer, dy * scale, ny)
            distance = np.maximum(distance, cutout)
    return distance, nx, ny


def tile_contour(box, size, dpi, state, geometry):
    """Page cuts extend the vertical edges instead of closing the outline."""
    left, top, right, bottom = box
    width, height = size
    pixels_per_mm = dpi / 25.4
    profile = PROFILES[geometry.profile]
    # Beautiful-but-concave native notches use the unmodified ys radius. Only
    # tcolorbox's rounded outer clip clamps its corners to the fragment size.
    max_radius = min(width, height) / 2 if geometry.shape == "rounded" else float("inf")
    radii = [min(max_radius, sp * dpi / SP_PER_INCH) for sp in geometry.corners]
    outside = profile.rim_mm * pixels_per_mm + max(radii) + 2
    above = outside if state in {"middle", "last"} else 0
    below = outside if state in {"first", "middle"} else 0
    if above:
        radii[:2] = [0, 0]
    if below:
        radii[2:] = [0, 0]
    x = (np.arange(left, right, dtype=np.float32) + .5)[None, :]
    y = (np.arange(top, bottom, dtype=np.float32) + .5 + above)[:, None]
    shape = notched_contour if geometry.shape == "notched" else round_contour
    return shape(x, y, width, height + above + below, radii)


def ray_field(distance, nx, ny, pixels_per_mm, refraction_mm, profile):
    rim = np.clip(1 + distance / (profile.rim_mm * pixels_per_mm), 0, 1)
    # The slope is the derivative of a cubic height ramp over the inset rim.
    slope = profile.max_slope * rim ** 2
    nz = 1 / np.sqrt(1 + slope ** 2)
    eta = 1 / IOR
    # Refract a normal-incidence view ray at the curved surface, then intersect
    # the plane of the backdrop. The effective depth is a fixed artistic proxy.
    scale = eta * nz - np.sqrt(1 - eta ** 2 * (1 - nz ** 2))
    transmitted_z = -eta + scale * nz
    delta = (scale * slope * nz / -transmitted_z) * (profile.depth_scale * refraction_mm * pixels_per_mm)
    fresnel = BASE_REFLECTION + (1 - BASE_REFLECTION) * (1 - nz) ** 5
    return delta * nx, delta * ny, rim, nx, ny, fresnel


def blur(image, sigma, *, precise=False):
    if sigma < .12:
        return image
    if sigma >= 8:
        # Three boxes approximate a Gaussian with bounded work for wide radii.
        ideal_radius = (np.sqrt(1 + 4 * sigma ** 2) - 1) / 2
        if precise:
            # A discrete box of radius r has variance r(r+1)/3. Mix the two
            # nearest odd widths so repeated passes match the target variance.
            low = int(np.floor(ideal_radius))
            high_count = round((sigma ** 2 - low * (low + 1)) / (2 * (low + 1) / 3))
            radii = (low,) * (3 - high_count) + (low + 1,) * high_count
        else:
            radii = (round(ideal_radius),) * 3
        for axis in (0, 1):
            rows = np.moveaxis(image, axis, 0)
            for radius in radii:
                window = 2 * radius + 1
                padded = np.pad(rows, ((radius + 1, radius), (0, 0), (0, 0)), mode="edge")
                if precise:
                    # The window subtracts two nearby prefix sums. Accumulate in
                    # Float64 so the result does not depend on the tile origin.
                    prefix = np.cumsum(padded, axis=0, dtype=np.float64)
                    rows = ((prefix[window:] - prefix[:-window]) / window).astype(np.float32)
                else:
                    np.cumsum(padded, axis=0, out=padded)
                    rows = (padded[window:] - padded[:-window]) / np.float32(window)
            image = np.moveaxis(rows, 0, axis)
        return image
    radius = max(1, int(np.ceil(3.5 * sigma)))
    kernel = np.exp(-.5 * (np.arange(-radius, radius + 1, dtype=np.float32) / sigma) ** 2)
    kernel /= np.sum(kernel)
    for axis in (0, 1):
        rows = np.moveaxis(image, axis, 0)
        padded = np.pad(rows, ((radius, radius), (0, 0), (0, 0)), mode="edge")
        filtered = np.zeros_like(rows)
        for offset, weight in enumerate(kernel):
            np.add(filtered, weight * padded[offset:offset + rows.shape[0]], out=filtered)
        image = np.moveaxis(filtered, 0, axis)
    return image


def sample(image, x, y):
    height, width = image.shape[:2]
    x, y = np.clip(x, 0, width - 1), np.clip(y, 0, height - 1)
    left, top = x.astype(np.int32), y.astype(np.int32)
    right, bottom = np.minimum(left + 1, width - 1), np.minimum(top + 1, height - 1)
    dx, dy = (x - left.astype(np.float32))[..., None], (y - top.astype(np.float32))[..., None]
    upper = image[top, left] * (1 - dx) + image[top, right] * dx
    lower = image[bottom, left] * (1 - dx) + image[bottom, right] * dx
    return upper * (1 - dy) + lower * dy


def film(image, pane, geometry):
    full_width, full_height, left, top = geometry
    x = (np.arange(image.shape[1], dtype=np.float32) + left + .5)[None, :]
    y = (np.arange(image.shape[0], dtype=np.float32) + top + .5)[:, None]
    tint = SRGB_LUT[[246, 250, 255] if pane.mode == "light" else [12, 24, 40]]
    veil = pane.mask * (.20 + .55 * x / full_width + .25 * y / full_height)
    opacity = (pane.opacity + (1 - pane.opacity) * veil)[..., None]
    image += (tint - image) * opacity
    if pane.sheen:
        sigma = max(1.0, pane.sheensize * min(full_width, full_height))
        distance = (x - pane.sheenx * full_width)**2 + (y - pane.sheeny * full_height)**2
        sheen = pane.sheen * np.exp(-.5 * distance / sigma**2)
        colour = SRGB_LUT[[255, 255, 255] if pane.mode == "light" else [100, 137, 158]]
        image += (colour - image) * sheen[..., None]
    if pane.rolloff and pane.mode == "light":
        threshold = SRGB_LUT[128]
        bright = np.maximum(0, (image - threshold) / (1 - threshold))
        image -= pane.rolloff * bright ** 2 * np.array([.23, .21, .19], dtype=np.float32)


def frost_diffusion(source, fine, wide):
    """Mix both photographic blur scales in the original sRGB appearance."""
    encoded = np.asarray(source, dtype=np.float32) / 255
    diffuse = blur(encoded, fine, precise=True)
    bloom = blur(encoded, wide, precise=True)
    return diffuse + (bloom - diffuse) * .38


def frost_tint(image, geometry):
    """Match the transparent smoke-to-sand tint of the reference material."""
    full_width, full_height, left, top = geometry
    rows, columns = image.shape[:2]
    u = (np.arange(columns, dtype=np.float32)[None, :] + left + .5) / full_width
    v = (np.arange(rows, dtype=np.float32)[:, None] + top + .5) / full_height
    luminance = image @ np.array([.2126, .7152, .0722], dtype=np.float32)
    image += (image - luminance[..., None]) * .12
    image *= .72
    image += .115
    smoke = np.array([83, 109, 113], dtype=np.float32) / 255
    sand = np.array([201, 178, 161], dtype=np.float32) / 255
    tint = smoke + (sand - smoke) * v[..., None]
    image += (tint - image) * .24
    sheen = np.clip(1 - (u / .95)**2 - (v / .9)**2, 0, 1)
    image += (1 - image) * (.035 * sheen)[..., None]
    return image


def frost_ink_contrast(image, target_contrast):
    """Protect small dark text locally, leaving the rest of the glass intact."""
    values = np.array(image)
    weights = np.array([.2126, .7152, .0722], dtype=np.float32)
    ink = float(SRGB_LUT[list(FROST_INK)] @ weights)
    required = target_contrast * (ink + .05) - .05
    if required > 1:
        raise ValueError("The requested contrast is outside the frost ink range")
    linear = SRGB_LUT[values]
    luma = linear @ weights
    affected = luma < required
    lift = np.clip((min(1, required + .002) - luma) / np.maximum(1 - luma, 1e-6), 0, 1)
    linear += (1 - linear) * np.where(affected, lift, 0)[..., None]
    if np.any(affected):
        values[affected] = to_srgb_byte(linear[affected])
        luma[affected] = SRGB_LUT[values[affected]] @ weights
    ratio = float(np.min((luma + .05) / (ink + .05)))
    return Image.fromarray(values), ratio, float(np.max(lift[affected], initial=0))


def frost_code_contrast(image, pane, dpi):
    """Attenuate only the listing surface, retaining the transmission colour."""
    values = np.array(image)
    weights = np.array([.2126, .7152, .0722], dtype=np.float32)
    ink = float(SRGB_LUT[list(FROST_CODE_REFERENCE)] @ weights)
    ceiling = (ink + .05) / pane.contrast - .05
    if ceiling < 0:
        raise ValueError("The requested contrast is outside the frost code ink range")
    # The native window clips its rim. Let the film meet that curve without
    # creating a second inset outline or a bright band under the last line.
    millimetres = 25.4 / dpi
    height = image.height
    y = (np.arange(height, dtype=np.float32) + .5) * millimetres
    coverage = np.ones(height, dtype=np.float32)
    if pane.state in {"unbroken", "first"}:
        # Start the dimming in the chrome and reach full contrast before the
        # first line. Partial attenuation at the top reduces the colour jump.
        s = np.clip((y - .5) / (10.5 - .5), 0, 1)
        ease = np.clip(s**3 * (s * (6 * s - 15) + 10), 0, 1)
        coverage = .52 + .48 * ease
    linear = SRGB_LUT[values]
    luma = linear @ weights
    # Leave room for sRGB rounding at the brightest permissible pixel.
    safe_ceiling = max(0, ceiling - .0017)
    attenuation = coverage[:, None] * np.maximum(0, 1 - safe_ceiling / np.maximum(luma, 1e-7))
    changed = attenuation > 0
    values[changed] = to_srgb_byte(linear[changed] * (1 - attenuation[changed, None]))
    body = coverage == coverage.max()
    brightest = np.max(SRGB_LUT[values[body]] @ weights)
    ratio = float((ink + .05) / (brightest + .05))
    return Image.fromarray(values), ratio, float(attenuation.max())


def render_tile(source, pane, box, size, margin, dpi, geometry, contour, reading_surface=None,
                text_colour=None, adaptive=0, *, body_only=False):
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    profile = PROFILES[contour.profile]
    dark_window = contour.profile in FROST_WINDOWS
    pixels_per_mm = dpi / 25.4
    lens = reading_surface is not None
    if not body_only:
        distance, nx, ny = tile_contour(box, size, dpi, pane.state, contour)
        if lens and not np.any(distance > -profile.rim_mm * pixels_per_mm):
            return reading_surface
        refraction = min(1.4, 7 * pane.refraction) if lens else pane.refraction
        dx, dy, rim, nx, ny, fresnel = ray_field(distance, nx, ny, pixels_per_mm, refraction, profile)
    if dark_window:
        fine, wide = frost_scales(pane)
        diffuse = frost_diffusion(source, fine * pixels_per_mm, wide * pixels_per_mm)
        image = diffuse[margin:margin + height, margin:margin + width].copy()
        full_width, full_height, fragment_left, fragment_top = geometry
        frost_tint(image, (full_width, full_height, fragment_left + left, fragment_top + top))
        return Image.fromarray(np.rint(np.clip(image, 0, 1) * 255).astype(np.uint8))
    linear = SRGB_LUT[np.asarray(source)]
    sigma = pane.blur * pixels_per_mm
    diffuse = blur(linear, sigma, precise=lens or body_only)
    if body_only:
        image = diffuse[margin:margin + height, margin:margin + width].copy()
    else:
        x = np.arange(width, dtype=np.float32)[None, :] + margin + dx
        y = np.arange(height, dtype=np.float32)[:, None] + margin + dy
        image = sample(diffuse, x, y)
        if sigma:
            sharp = sample(blur(linear, sigma * .22, precise=lens), x, y)
            image += (sharp - image) * (profile.rim_sharpness * rim ** 1.4)[..., None]
    luminance = .2126 * image[..., 0] + .7152 * image[..., 1] + .0722 * image[..., 2]
    image = luminance[..., None] + pane.saturation * (image - luminance[..., None])
    full_width, full_height, fragment_left, fragment_top = geometry
    tile_geometry = (full_width, full_height, fragment_left + left, fragment_top + top)
    film(image, pane, tile_geometry)

    if not (lens or body_only):
        facing = -.60 * nx - .80 * ny
        reflected = profile.reflection * rim ** 2 * (.16 + .84 * np.maximum(0, facing)) * (fresnel / BASE_REFLECTION)
        reflection_colour = SRGB_LUT[[250, 254, 255] if pane.mode == "light" else [158, 189, 207]]
        image += (reflection_colour - image) * np.minimum(reflected, .58)[..., None]
        shade = profile.shade * rim ** 2 * np.maximum(0, -facing)
        image *= 1 - shade[..., None]
    if pane.grain:
        # A coordinate hash makes the grain independent of tiling and page cuts.
        xx = np.arange(width, dtype=np.uint32)[None, :] + fragment_left + left
        yy = np.arange(height, dtype=np.uint32)[:, None] + fragment_top + top
        seed = np.uint32((pane.logical * 0x9E3779B9) & 0xFFFFFFFF)
        grain = (xx * np.uint32(0x73FBAE33)) ^ (yy * np.uint32(0x4F1BBCDD)) ^ seed
        grain = (grain ^ (grain >> 16)) * np.uint32(0x7FEB352D)
        grain = (grain ^ (grain >> 15)) * np.uint32(0x846CA68B)
        value = ((grain ^ (grain >> 16)) >> 8).astype(np.float32) * (1 / 16777216)
        image += (value[..., None] - .5) * (.32 * pane.grain)
    if lens:
        facing = -.43 * nx - .81 * ny
        # The unlit bottom and right are the reading surface. Only the lit
        # bevel can expose the more sharply sampled, displaced backdrop.
        transmission = rim * rim * (3 - 2 * rim) * np.maximum(0, facing) ** .7
        glint = lens_highlight(distance / pixels_per_mm, nx, ny, facing, rim, fresnel,
                               profile, pane.mode, tile_geometry, contour.glint, pixels_per_mm)
        return composite_lens(reading_surface, image, transmission, glint, pane, text_colour, adaptive)
    return Image.fromarray(to_srgb_byte(image))


def lens_highlight(distance_mm, nx, ny, facing, rim, fresnel, profile, mode,
                   geometry, glint, pixels_per_mm):
    """Return specular coverage separately from the transmitted reading surface."""
    inset = -distance_mm
    dark_side = np.maximum(0, -facing)

    default_opacity = .72 if mode == "light" else .27
    width_sp, opacity = glint if glint is not None else (.70 * 65536, default_opacity)
    if width_sp == 0 or opacity == 0:
        return np.zeros_like(distance_mm)
    full_width, full_height, left, top = geometry
    height, width = distance_mm.shape
    u = (np.arange(width, dtype=np.float32)[None, :] + left + .5) / full_width
    v = (np.arange(height, dtype=np.float32)[:, None] + top + .5) / full_height
    spread = np.maximum(0, 1 - ((u - .22) / .66) ** 2 - ((v - .09) / .83) ** 2) ** 2
    bounce = np.maximum(0, 1 - ((u - .84) / .19) ** 2 - ((v - 1) / .24) ** 2) ** 2

    # Use the same curved surface normal as refraction. The half vector is
    # the bisector of the incident light and the straight-on PDF view ray.
    slope = profile.max_slope * rim ** 2
    normal_z = 1 / np.sqrt(1 + slope ** 2)
    normal_light_xy = facing * slope * normal_z
    incident = np.maximum(0, normal_light_xy + .40 * normal_z)
    half_dot = np.clip((normal_light_xy + 1.40 * normal_z) / np.sqrt(2.8), 0, 1)
    corner_glint = 1 + .48 * np.abs(2 * nx * ny)
    specular = spread * half_dot ** 6 * np.sqrt(incident) * corner_glint
    fresnel_weight = np.sqrt(fresnel / BASE_REFLECTION)
    reflected = .065 * bounce * dark_side ** 2

    # Integrate the line profile over the pixel square using two Gauss points
    # on each axis. The dot product projects each point onto the rim normal.
    sigma = width_sp * 25.4 / (SP_PER_INCH * 2.35482)
    line_distance = inset - (.085 + .72 * sigma)
    node_mm = 1 / (2 * np.sqrt(3) * pixels_per_mm)
    x, y = nx * node_mm, ny * node_mm
    streak = sum(np.exp(-.5 * ((line_distance + shift) / sigma) ** 2)
                 for shift in (x + y, x - y, y - x, -x - y)) * .25
    # Outside the finite bevel, the colour stays exactly the reading surface.
    return np.where(rim > 0, np.minimum(1.85 * opacity * streak * (specular + reflected) * fresnel_weight, .86), 0)


def composite_lens(reading_surface, edge, transmission, glint, pane, text_colour, adaptive):
    """Blend only the rim; correct its luminance locally against the reading ink."""
    base = np.asarray(reading_surface)
    base_linear = SRGB_LUT[base]
    if adaptive:
        # Match the body tone before mixing so a strong dark-reading guard does
        # not leave a bright seam between the lens and its protected interior.
        encoded_edge = to_srgb(edge)
        target = 1 if pane.mode == "light" else 0
        edge = to_linear(encoded_edge + (target - encoded_edge) * adaptive)
    mixed = base_linear + (edge - base_linear) * transmission[..., None]
    white = 1.0 if pane.mode == "light" else SRGB_LUT[[240, 249, 255]]
    mixed += (white - mixed) * glint[..., None]
    mixed = np.clip(mixed, 0, 1)
    if pane.contrast > 1:
        weights = np.array((.2126, .7152, .0722), dtype=np.float32)
        text = float(SRGB_LUT[list(text_colour)] @ weights)
        luminance = mixed @ weights
        if pane.mode == "light":
            limit = pane.contrast * (text + .05) - .05
            lift = np.clip((min(1, limit + .0045) - luminance) / np.maximum(1 - luminance, 1e-6), 0, 1)
            mixed += (1 - mixed) * lift[..., None]
        else:
            limit = (text + .05) / pane.contrast - .05
            dim = np.clip(max(0, limit - .0045) / np.maximum(luminance, 1e-6), 0, 1)
            mixed *= dim[..., None]
    encoded = to_srgb_byte(mixed)
    keep_base = (transmission == 0) & (glint < 1e-6)
    if pane.contrast > 1:
        # Quantization can land fractionally below the float threshold. The
        # protected reading surface provides a valid fallback at those pixels.
        encoded_luminance = SRGB_LUT[encoded] @ weights
        bad = encoded_luminance < limit + 1e-6 if pane.mode == "light" else encoded_luminance > limit - 1e-6
        keep_base |= bad
    np.copyto(encoded, base, where=keep_base[..., None])
    return Image.fromarray(encoded)


def render_tiles(source, pane, width, height, margin, dpi, geometry, contour, reading_surface=None,
                 text_colour=None, adaptive=0, *, body_only=False):
    halo = min(margin, sampling_halo(pane, dpi, contour.profile))
    image = Image.new("RGB", (width, height))
    for top in range(0, height, TILE_SIZE):
        for left in range(0, width, TILE_SIZE):
            right, bottom = min(width, left + TILE_SIZE), min(height, top + TILE_SIZE)
            tile_source = source.crop((margin + left - halo, margin + top - halo,
                                       margin + right + halo, margin + bottom + halo))
            box = (left, top, right, bottom)
            base = reading_surface.crop(box) if reading_surface is not None else None
            tile = render_tile(tile_source, pane, box, (width, height), halo, dpi, geometry, contour,
                               base, text_colour, adaptive, body_only=body_only)
            image.paste(tile, (left, top))
    return image


def render(source, pane, width, height, margin, dpi, geometry, contour, contrast_guard, text_colour=None):
    """Compute local Float32 tiles and preserve the detached reading surface."""
    if contour.profile == "reading-lens":
        reading = replace(contour, profile="reading")
        base = render_tiles(source, pane, width, height, margin, dpi, geometry, reading, body_only=True)
        base, _, adaptive = contrast_guard(base, pane)
        image = render_tiles(source, pane, width, height, margin, dpi, geometry, contour, base, text_colour, adaptive)
        image, ratio, _ = contrast_guard(image, pane)
        return image, ratio, adaptive
    image = render_tiles(source, pane, width, height, margin, dpi, geometry, contour)
    if contour.profile in FROST_WINDOWS:
        return frost_ink_contrast(image, pane.contrast)
    return contrast_guard(image, pane)
