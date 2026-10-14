#!/usr/bin/env python3
"""Cuts the raw screencast clips into segments, burns in caption PNGs, and joins them.

Run: python3 demo/assemble.py demo/plan.json
Plan: {"raw": "demo/raw", "segments": [{"clip": "01-golive", "from": ms, "to": ms, "speed": 1.0, "cap": "01"} | {"still": "demo/cards/endcard.png", "dur": 8}]}
Output: demo/memestream-demo.mp4 (1920x1080, 30 fps, H.264, no audio) and demo/memestream-demo.srt.
"""
import bisect, json, os, shutil, subprocess, sys, tempfile

FPS = 30
plan = json.load(open(sys.argv[1]))
raw = plan["raw"]
caps = {c["id"]: c for c in json.load(open("demo/captions.json"))}
work = tempfile.mkdtemp(prefix="demo-assemble-")
seg_files, srt, t_total = [], [], 0.0
FADE = 0.25


def ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


segs = plan["segments"]
for n, seg in enumerate(segs):
    fin = n == 0 or segs[n - 1].get("cap") != seg.get("cap") or "still" in seg
    fout = n == len(segs) - 1 or segs[n + 1].get("cap") != seg.get("cap") or "still" in seg
    out = os.path.join(work, f"seg{n:02d}.mp4")
    if "still" in seg:
        dur = seg["dur"]
        vf = f"scale=1920:1080,format=yuv420p,fade=t=in:st=0:d={FADE},fade=t=out:st={dur - FADE}:d={FADE}"
        ff("-loop", "1", "-framerate", str(FPS), "-t", str(dur), "-i", seg["still"], "-vf", vf,
           "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", str(FPS), "-an", out)
    else:
        meta = json.load(open(os.path.join(raw, seg["clip"], "frames.json")))
        times = meta["frames"]
        speed = seg.get("speed", 1.0)
        start, end = seg["from"], seg["to"]
        nframes = int(round((end - start) / speed / 1000 * FPS))
        seq = os.path.join(work, f"seq{n:02d}")
        os.makedirs(seq)
        for i in range(nframes):
            src_t = start + i * speed * 1000 / FPS
            k = max(0, bisect.bisect_right(times, src_t) - 1)
            os.symlink(os.path.abspath(os.path.join(raw, seg["clip"], f"{k:05d}.jpg")), os.path.join(seq, f"{i:06d}.jpg"))
        dur = nframes / FPS
        base = (f"[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,"
                f"pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x1b1b22,setsar=1[b]")
        inputs = ["-framerate", str(FPS), "-i", os.path.join(seq, "%06d.jpg")]
        if seg.get("cap"):
            inputs += ["-i", f"demo/cards/cap-{seg['cap']}.png"]
            fc = base + ";[b][1:v]overlay=0:0[c];[c]"
        else:
            fc = base + ";[b]"
        fc += "format=yuv420p"
        if fin:
            fc += f",fade=t=in:st=0:d={FADE}"
        if fout:
            fc += f",fade=t=out:st={dur - FADE:.3f}:d={FADE}"
        fc += "[v]"
        ff(*inputs, "-filter_complex", fc, "-map", "[v]", "-c:v", "libx264", "-preset", "medium",
           "-crf", "18", "-r", str(FPS), "-an", out)
    cap = seg.get("cap") and caps[seg["cap"]]
    if cap:
        text = cap["text"] + (f"\n{cap['sub']}" if cap.get("sub") else "")
        srt.append((t_total, t_total + dur, text))
    elif "still" in seg and seg.get("srt"):
        srt.append((t_total, t_total + dur, seg["srt"]))
    t_total += dur
    seg_files.append(out)
    print(f"seg {n}: {seg.get('clip', seg.get('still'))} {dur:.2f}s  (total {t_total:.2f}s)")

lst = os.path.join(work, "list.txt")
with open(lst, "w") as f:
    for s in seg_files:
        f.write(f"file '{s}'\n")
ff("-f", "concat", "-safe", "0", "-i", lst, "-c:v", "libx264", "-preset", "slow", "-crf", "20",
   "-pix_fmt", "yuv420p", "-r", str(FPS), "-movflags", "+faststart", "-an", "demo/memestream-demo.mp4")


def ts(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


# Merge back-to-back segments that carry the same caption into one cue.
merged = []
for a, b, text in srt:
    if merged and merged[-1][2] == text and abs(merged[-1][1] - a) < 0.01:
        merged[-1] = (merged[-1][0], b, text)
    else:
        merged.append((a, b, text))
with open("demo/memestream-demo.srt", "w") as f:
    for i, (a, b, text) in enumerate(merged, 1):
        f.write(f"{i}\n{ts(a)} --> {ts(b)}\n{text}\n\n")
shutil.rmtree(work)
print(f"done: {t_total:.2f}s")
