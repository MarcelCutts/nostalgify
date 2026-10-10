"""Draws the Nostalgify icon: a pixel-art spectrum analyser in a bevelled case.

Writes build/icon.png (1024px) and build/icon.icns by default.
With --ipad, writes the full-square opaque iPad asset using the same artwork.
Needs numpy; macOS output additionally needs sips and iconutil.
Run: python3 scripts/make-icon.py
     python3 scripts/make-icon.py --ipad
"""
import argparse
import os
import struct
import subprocess
import tempfile
import zlib

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
G = 32  # the art is drawn on a 32x32 grid, then scaled up with hard edges


def hexc(h, a=255):
    h = h.lstrip("#")
    return [int(h[i : i + 2], 16) for i in (0, 2, 4)] + [a]


def draw_grid():
    img = np.zeros((G, G, 4), np.uint8)
    case_hi, case, case_lo = hexc("#5f7a5f"), hexc("#2c3a2c"), hexc("#121a12")
    img[:, :] = case
    # Bevel: light top/left, dark bottom/right, like a Win98 panel.
    img[0, :] = case_hi
    img[:, 0] = case_hi
    img[G - 1, :] = case_lo
    img[:, G - 1] = case_lo
    # Title bar stripe.
    img[2:4, 3 : G - 3] = hexc("#9fd49f")
    img[2:4, 13:19] = case  # gap in the stripe, as if for a title
    # Screen, sunken.
    top, left, bottom, right = 6, 3, G - 4, G - 3
    img[top - 1, left - 1 : right + 1] = case_lo
    img[top - 1 : bottom + 1, left - 1] = case_lo
    img[bottom, left - 1 : right + 1] = case_hi
    img[top - 1 : bottom + 1, right] = case_hi
    img[top:bottom, left:right] = hexc("#000000")
    # Faint grid dots on the screen.
    for y in range(top + 1, bottom, 2):
        for x in range(left + 1, right, 2):
            img[y, x] = hexc("#0f2a0f")
    # Spectrum bars, classic green-to-yellow-to-red.
    heights = [9, 14, 18, 15, 11, 16, 12, 7, 10, 5, 8, 6, 3]
    ramp = ["#00c000", "#00d800", "#18e010", "#40e818", "#78f020", "#a8f028", "#d8e830", "#f0c828", "#f09820", "#e86018", "#e03010"]
    floor = bottom - 1
    x = left + 1
    for h in heights:
        for i in range(h):
            y = floor - i
            if y <= top:
                break
            c = ramp[min(len(ramp) - 1, int(i / 18 * len(ramp)))]
            img[y, x] = hexc(c)
        peak = floor - h - 1
        if peak > top:
            img[peak, x] = hexc("#c8c8c8")
        x += 2
    return img


def rounded_canvas(grid, size=1024):
    # macOS icons sit on a rounded square with some padding around it.
    pad = 100
    inner = size - 2 * pad
    scale = inner // G
    art = np.kron(grid, np.ones((scale, scale, 1), np.uint8))
    canvas = np.zeros((size, size, 4), np.uint8)
    off = (size - art.shape[0]) // 2
    canvas[off : off + art.shape[0], off : off + art.shape[1]] = art
    # Round the corners.
    r = 180
    yy, xx = np.mgrid[0:size, 0:size]
    a0, a1 = off, off + art.shape[0] - 1
    for cy, cx in [(a0 + r, a0 + r), (a0 + r, a1 - r), (a1 - r, a0 + r), (a1 - r, a1 - r)]:
        corner = ((yy < a0 + r) if cy == a0 + r else (yy > a1 - r)) & ((xx < a0 + r) if cx == a0 + r else (xx > a1 - r))
        outside = corner & ((yy - cy) ** 2 + (xx - cx) ** 2 > r * r)
        canvas[outside] = 0
    return canvas


def write_png(path, pixels):
    h, w, channels = pixels.shape
    if channels not in (3, 4):
        raise ValueError("PNG pixels must be RGB or RGBA")
    raw = b"".join(b"\x00" + pixels[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2 if channels == 3 else 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ipad", action="store_true", help="Build the opaque 1024px iPad AppIcon without macOS tools")
    args = parser.parse_args()
    grid = draw_grid()
    if args.ipad:
        # iPadOS applies its own corner mask; supply neither padding nor alpha.
        icon = np.repeat(np.repeat(grid[:, :, :3], 1024 // G, axis=0), 1024 // G, axis=1)
        path = os.path.join(ROOT, "apps/ipad/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")
        write_png(path, icon)
        print("wrote " + os.path.relpath(path, ROOT))
        return
    icon = rounded_canvas(grid)
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    png = os.path.join(ROOT, "build", "icon.png")
    write_png(png, icon)
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for s in [16, 32, 64, 128, 256, 512]:
            for mult, suffix in [(1, ""), (2, "@2x")]:
                px = s * mult
                out = os.path.join(iconset, f"icon_{s}x{s}{suffix}.png")
                subprocess.run(["sips", "-z", str(px), str(px), png, "--out", out], check=True, capture_output=True)
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(ROOT, "build", "icon.icns")], check=True)
    print("wrote build/icon.png and build/icon.icns")


if __name__ == "__main__":
    main()
