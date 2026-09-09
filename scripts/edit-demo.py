#!/usr/bin/env python3
"""
Cut a recorded demo into a video for social media.

    python3 scripts/edit-demo.py video build/demo          # from record-demo.mjs
    python3 scripts/edit-demo.py stills <dir> [outdir]     # from the guide screenshots

The frame is 1080x1080: a title bar, the capture itself, and a caption band.
Each beat of the recording becomes one cut, zoomed into the part of the
interface that matters then (native pixels wherever possible, so the app stays
legible on a phone) and sped up where the machine, not the user, is working.
"""

import json
import math
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W = H = 1080          # LinkedIn square
BAR = 96              # title bar
BAND_H = 724          # the capture band
CAP_Y = BAR + BAND_H  # caption band starts here
FPS = 30

BG = (15, 23, 42)
FG = (233, 238, 246)
MUTED = (148, 163, 184)
ACCENT = (56, 132, 255)

FONTS = Path("/usr/share/fonts/truetype/google-fonts")
def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)

BOLD, MED, REG = "Poppins-Bold.ttf", "Poppins-Medium.ttf", "Poppins-Regular.ttf"
SUBTITLE = "Vesuvius, Campania"


def run(args):
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-3000:])
        raise SystemExit(f"ffmpeg failed: {' '.join(args[:6])} …")


def wrap(draw, text, fnt, max_w):
    words, lines, line = text.split(), [], ""
    for word in words:
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=fnt) <= max_w:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def chrome(caption, step=None, steps=None):
    """The static frame: title bar and caption band, transparent over the capture."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, BAR], fill=BG + (255,))
    d.rectangle([0, CAP_Y, W, H], fill=BG + (255,))

    title = font(BOLD, 34)
    d.text((44, 28), "movecost", font=title, fill=FG)
    d.text((44 + d.textlength("movecost", font=title) + 14, 34),
           "for GeoLibre", font=font(MED, 27), fill=MUTED)
    tag = "least-cost paths · R in the browser"
    d.text((W - 44 - d.textlength(tag, font=font(MED, 22)), 38), tag,
           font=font(MED, 22), fill=ACCENT)

    fnt = font(BOLD, 46)
    lines = wrap(d, caption, fnt, W - 108)
    if len(lines) > 2:
        fnt = font(BOLD, 38)
        lines = wrap(d, caption, fnt, W - 108)
    y = CAP_Y + (H - CAP_Y - len(lines) * (fnt.size + 12)) / 2 + 2
    for line in lines:
        d.text((54, y), line, font=fnt, fill=FG)
        y += fnt.size + 12

    if step:
        s = f"{step}/{steps}"
        d.text((W - 54 - d.textlength(s, font=font(MED, 24)), H - 46), s,
               font=font(MED, 24), fill=MUTED)
    return img


def card(kind):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    if kind == "title":
        d.text((72, 300), "Least-cost paths", font=font(BOLD, 84), fill=FG)
        d.text((72, 396), "in the browser", font=font(BOLD, 84), fill=ACCENT)
        for i, line in enumerate([
            "The movecost R package, as a GeoLibre plugin.",
            "No server, no R installation — and it runs on an iPad.",
        ]):
            d.text((74, 536 + i * 46), line, font=font(REG, 32), fill=MUTED)
        d.rectangle([72, 500, 172, 506], fill=ACCENT)
        d.text((74, 700), SUBTITLE, font=font(MED, 26), fill=MUTED)
    else:
        d.text((72, 250), "Open source", font=font(BOLD, 72), fill=FG)
        for i, line in enumerate([
            "github.com/enzococca/geolibre-movecost",
            "enzococca.github.io/geolibre-movecost/guide/",
        ]):
            d.text((74, 390 + i * 56), line, font=font(MED, 32), fill=ACCENT)
        d.text((74, 520), "Runs on the desktop and on an iPad: R compiled to WebAssembly.",
               font=font(MED, 28), fill=FG)
        d.text((74, 590), "movecost by Gianmarco Alberti (SoftwareX, 2019)",
               font=font(REG, 28), fill=MUTED)
        d.text((74, 634), "GeoLibre by Qiusheng Wu and the opengeos community",
               font=font(REG, 28), fill=MUTED)
        d.text((74, 760), "Enzo Cocca — archaeology, GIS, software",
               font=font(MED, 30), fill=FG)
    return img


def crop_window(rects, focus, src_w, src_h, dsf):
    """A window of the source that fills the band, in native pixels when it fits."""
    want_w, want_h = int(W * dsf), int(BAND_H * dsf)
    if focus == "full":
        # Not the whole window: shrinking 1440 px of interface into a 1080 px
        # frame leaves the labels unreadable on a phone. A centred crop of a
        # little more than the band keeps almost everything and stays legible.
        wide_w, wide_h = int(want_w * 1.17), int(want_h * 1.17)
        if wide_w <= src_w and wide_h <= src_h:
            return ((src_w - wide_w) // 2, (src_h - wide_h) // 2, wide_w, wide_h)
        return None
    if want_w > src_w or want_h > src_h:
        return None                                          # scale the whole frame instead
    r = rects.get(focus) or {}
    rx, ry = r.get("x", 0), r.get("y", 0)
    rw, rh = r.get("w", src_w), r.get("h", src_h)
    if focus == "panel":                                     # keep the panel's right edge
        x = rx + rw - want_w
    elif focus == "layers":
        x = rx
    else:                                                    # centre on the region
        x = rx + rw / 2 - want_w / 2
    y = ry + rh / 2 - want_h / 2
    x = int(max(0, min(x, src_w - want_w)))
    y = int(max(0, min(y, src_h - want_h)))
    return x, y, want_w, want_h


def segment_video(src, start, end, focus, speed, rects, src_w, src_h, dsf, overlay, out):
    win = crop_window(rects, focus, src_w, src_h, dsf)
    if win:
        x, y, w, h = win
        chain = f"crop={w}:{h}:{x}:{y},scale={W}:{BAND_H}:flags=lanczos"
        pad_x, pad_y = 0, BAR
    else:
        band_h = min(BAND_H, int(W * src_h / src_w))
        band_w = int(band_h * src_w / src_h) // 2 * 2
        chain = f"scale={band_w}:{band_h}:flags=lanczos"
        pad_x, pad_y = (W - band_w) // 2, BAR + (BAND_H - band_h) // 2
    vf = (
        f"[0:v]{chain},setpts=PTS/{speed},fps={FPS}[v];"
        f"[v]pad={W}:{H}:{pad_x}:{pad_y}:color=0x0f172a[p];"
        f"[p][1:v]overlay=0:0:format=auto[o]"
    )
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(src),
        "-i", str(overlay),
        "-filter_complex", vf, "-map", "[o]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-r", str(FPS), "-an", str(out),
    ])


def segment_still(src, duration, overlay, out, frame=(0.5, 0.5, 1.0), drift=0.05):
    """One still, framed on a region and drifting slowly.

    `frame` is (centre x, centre y, width) as fractions of the source, so the
    same beat list works whatever the screenshot's resolution. PIL does the
    cropping and scaling — crisp, and far quicker than ffmpeg's zoompan, which
    rescaled the whole screenshot once per frame.
    """
    im = Image.open(src).convert("RGB")
    sw, sh = im.size
    cx, cy, zw = frame
    band_h = BAND_H if zw < 0.999 else min(BAND_H, int(W * sh / sw))
    band_w = W if zw < 0.999 else int(band_h * sw / sh)
    band_w, band_h = band_w // 2 * 2, band_h // 2 * 2
    aspect = band_w / band_h

    crop_w = min(sw, sw * zw * (1 + drift))
    crop_h = min(sh, crop_w / aspect)
    crop_w = crop_h * aspect
    x = min(max(cx * sw - crop_w / 2, 0), sw - crop_w)
    y = min(max(cy * sh - crop_h / 2, 0), sh - crop_h)
    window = im.crop((int(x), int(y), int(x + crop_w), int(y + crop_h)))
    big = window.resize((int(band_w * (1 + drift)) // 2 * 2,
                         int(band_h * (1 + drift)) // 2 * 2), Image.LANCZOS)
    tmp = out.with_suffix(".src.png")
    big.save(tmp)

    pad_x, pad_y = (W - band_w) // 2, BAR + (BAND_H - band_h) // 2
    vf = (
        f"[0:v]crop={band_w}:{band_h}:"
        f"'(iw-ow)*(0.12+0.76*t/{duration})':'(ih-oh)*(0.8-0.6*t/{duration})',"
        f"fps={FPS}[v];"
        f"[v]pad={W}:{H}:{pad_x}:{pad_y}:color=0x0f172a[p];"
        f"[p][1:v]overlay=0:0:format=auto[o]"
    )
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-loop", "1", "-t", f"{duration}", "-i", str(tmp),
        "-i", str(overlay),
        "-filter_complex", vf, "-map", "[o]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-r", str(FPS), "-an", str(out),
    ])
    tmp.unlink(missing_ok=True)


def card_clip(kind, duration, out):
    png = out.with_suffix(".png")
    card(kind).save(png)
    run([
        "ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-t", f"{duration}",
        "-i", str(png), "-vf", f"fps={FPS},format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", str(FPS), "-an", str(out),
    ])


def concat(parts, out, total):
    listing = parts[0].parent / "parts.txt"
    listing.write_text("".join(f"file '{p.name}'\n" for p in parts))
    joined = parts[0].parent / "joined.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(listing), "-c", "copy", str(joined)])
    # A progress line under the title bar, and a silent track so every player is happy.
    run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(joined),
        "-f", "lavfi", "-t", f"{total:.2f}", "-i", "anullsrc=r=48000:cl=stereo",
        "-vf", f"drawbox=x=0:y={BAR-5}:w='iw*t/{total:.2f}':h=5:color=0x3884ff@0.95:t=fill",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", str(out),
    ])
    joined.unlink(missing_ok=True)
    listing.unlink(missing_ok=True)


def duration_of(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True).stdout.strip()
    return float(out)


def build_video(demo_dir):
    demo_dir = Path(demo_dir)
    meta = json.loads((demo_dir / "timeline.json").read_text())
    src = demo_dir / "raw.webm"
    src_w, src_h = meta["width"], meta["height"]
    beats = meta["timeline"]
    total_src = duration_of(src)
    work = demo_dir / "parts"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)

    # Each beat runs until the next one; the recorder appends a closing marker.
    spans = [
        (b, beats[i + 1]["t"] if i + 1 < len(beats) else total_src)
        for i, b in enumerate(beats) if b["caption"] != "__end__"
    ]
    parts = []
    card_clip("title", 2.4, work / "00-title.mp4")
    parts.append(work / "00-title.mp4")
    for i, (beat, end) in enumerate(spans):
        start = beat["t"]
        end = min(end, total_src)
        if end - start < 0.4:
            continue
        overlay = work / f"cap-{i:02d}.png"
        chrome(beat["caption"], i + 1, len(spans)).save(overlay)
        out = work / f"{i+1:02d}-beat.mp4"
        segment_video(src, start, end, beat.get("focus", "full"), beat.get("speed", 1),
                      meta["rects"], src_w, src_h, 1, overlay, out)
        parts.append(out)
        print(f"  beat {i+1}/{len(spans)}  {end-start:5.1f}s ×{beat.get('speed',1)} "
              f"→ {duration_of(out):4.1f}s  {beat['caption'][:52]}")
    card_clip("end", 2.8, work / "99-end.mp4")
    parts.append(work / "99-end.mp4")
    total = sum(duration_of(p) for p in parts)
    out = demo_dir / "movecost-demo-1080x1080.mp4"
    concat(parts, out, total)
    print(f"\n{out}  {total:.1f}s  {out.stat().st_size/1e6:.1f} MB")


# (file, caption, seconds, framing) — framing is (centre x, centre y, width)
# in fractions of the screenshot, so a beat can sit on the panel, the map or
# the whole window. GeoLibre at 1440 x 900: Layers ~0.04-0.25, map ~0.25-0.72,
# the plugin panel ~0.72-0.97.
STILL_BEATS = [
    ("01-plugin-activated.png", "Least-cost path analysis inside GeoLibre",
     3.2, (0.5, 0.5, 1.0)),
    ("02-panel-open.png", "No R to install: R itself runs in the page",
     3.8, (0.84, 0.42, 0.42)),
    ("03-study-area.png", "Pompeii, Herculaneum and Oplontis around Vesuvius",
     3.6, (0.47, 0.52, 0.60)),
    ("06-points-from-layers.png", "The DEM is sized before it is fetched",
     3.4, (0.845, 0.55, 0.40)),
    ("05-dem-downloaded.png", "Elevation downloaded and projected to UTM",
     3.6, (0.47, 0.52, 0.60)),
    ("06-points-from-layers.png", "Origin and destinations: from a layer, or clicked",
     3.6, (0.47, 0.52, 0.52)),
    ("07-results.png", "Cost surface, isolines and the least-cost paths",
     4.4, (0.47, 0.52, 0.52)),
    ("07-results.png", "Every result is a native, grouped GeoLibre layer",
     3.6, (0.16, 0.5, 0.32)),
]


def build_stills(src_dir, out_dir):
    src_dir, out_dir = Path(src_dir), Path(out_dir)
    work = out_dir / "parts"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    parts = [work / "00-title.mp4"]
    card_clip("title", 2.4, parts[0])
    for i, (name, caption, dur, frame) in enumerate(STILL_BEATS):
        still = src_dir / name
        if not still.exists():
            print("  missing", name)
            continue
        overlay = work / f"cap-{i:02d}.png"
        chrome(caption, i + 1, len(STILL_BEATS)).save(overlay)
        out = work / f"{i+1:02d}-still.mp4"
        segment_still(still, dur, overlay, out, frame)
        parts.append(out)
        print(f"  still {i+1}/{len(STILL_BEATS)}  {dur:.1f}s  {caption[:52]}")
    parts.append(work / "99-end.mp4")
    card_clip("end", 2.8, parts[-1])
    total = sum(duration_of(p) for p in parts)
    out = out_dir / "movecost-preview-1080x1080.mp4"
    concat(parts, out, total)
    print(f"\n{out}  {total:.1f}s  {out.stat().st_size/1e6:.1f} MB")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "video"
    if mode == "stills":
        build_stills(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "build/demo")
    else:
        build_video(sys.argv[2] if len(sys.argv) > 2 else "build/demo")
