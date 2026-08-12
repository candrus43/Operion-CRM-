#!/usr/bin/env python3
"""Generate Operion CRM PWA icons from the brand logo.

The app's brand mark IS public/logo.png (the violet→blue aurora "O" on near-black),
so the most brand-faithful icons are resizes of it — no new artwork to drift from
the design. Outputs:

  public/icons/icon-192.png           192x192   purpose: any
  public/icons/icon-512.png           512x512   purpose: any
  public/icons/icon-maskable-512.png  512x512   purpose: maskable (mark shrunk
                                                inside the launcher safe zone)
  public/apple-touch-icon.png         180x180   iOS home screen (opaque, no alpha)

Background is the app's ink token (#08080a, src/styles/app.css --color-ink);
the maskable variant feathers the pasted square's edges into the ink so no seam
shows under launcher masks.

Run from the site root:  python3 scripts/gen-pwa-icons.py
Requires Pillow (python3 -m pip install --user pillow --break-system-packages).
"""
from PIL import Image, ImageDraw, ImageFilter

INK = (8, 8, 10)  # --color-ink: #08080a
SOURCE = "public/logo.png"

# Mark occupies ~76% of the logo canvas; resizing the whole logo to 100% of the
# icon canvas keeps the exact proportions the app already uses.
MARK_FRACTION = 0.76
MASKABLE_FRACTION = 0.60  # mark lands at ~46% of canvas — safely inside the 80% mask circle


def feather_into_ink(img: Image.Image, margin_frac: float = 0.07) -> Image.Image:
    """Radial-feather the pasted square's edges into the ink background."""
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    cx, cy = w / 2, h / 2
    inner_r = (cx * cx + cy * cy) ** 0.5 * (1 - margin_frac)
    d.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(2, w * 0.02)))
    ink_layer = Image.new("RGB", (w, h), INK)
    # mask=255 → keep the image (center); mask=0 → ink (outer edge/corners)
    return Image.composite(img.convert("RGB"), ink_layer, mask)


def make_icon(size: int, fill_frac: float, out_path: str, feather: bool) -> None:
    src = Image.open(SOURCE).convert("RGB")
    canvas = Image.new("RGB", (size, size), INK)
    fill = int(size * fill_frac / MARK_FRACTION)  # how big the source square must be
    fill = min(fill, size)
    mark = src.resize((fill, fill), Image.LANCZOS)
    canvas.paste(mark, ((size - fill) // 2, (size - fill) // 2))
    if feather:
        canvas = feather_into_ink(canvas)
    canvas.save(out_path, "PNG", optimize=True)
    print(f"wrote {out_path} ({size}x{size})")


if __name__ == "__main__":
    make_icon(192, MARK_FRACTION, "public/icons/icon-192.png", feather=False)
    make_icon(512, MARK_FRACTION, "public/icons/icon-512.png", feather=False)
    make_icon(512, MASKABLE_FRACTION, "public/icons/icon-maskable-512.png", feather=True)
    make_icon(180, MARK_FRACTION, "public/apple-touch-icon.png", feather=False)
