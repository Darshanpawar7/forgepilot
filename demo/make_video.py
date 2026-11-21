"""Cuts the raw screen recording into the submission video (<= 4 min).

Real-time sections stay at 1x. The stretches where the model is thinking (between
"MARK fast on/off" in demo-log.txt) are sped up and labelled on screen with their speed.
Usage: python make_video.py raw.mp4 demo-log.txt rec-start.txt out.mp4
"""
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

RAW, LOG, START, OUT = (Path(a) for a in sys.argv[1:5])
TARGET_SECONDS = 232          # leave margin under the 240 s limit
TITLE_SECONDS = 6
LEAD_IN = 1.5                 # ffmpeg starts capturing about this long before rec-start.txt is written
MAX_FAST_SPEED = 16
FONT = "C\\:/Windows/Fonts/segoeui.ttf"
FONT_BOLD = "C\\:/Windows/Fonts/segoeuib.ttf"
WORK = OUT.parent / "cuts"
WORK.mkdir(exist_ok=True)


def secs(hms):
    return datetime.strptime(hms, "%H:%M:%S")


def run(args):
    subprocess.run(args, check=True)


def esc(text):
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\u2019").replace("%", "\\%")


def duration(path):
    out = subprocess.run(["ffmpeg", "-i", str(path)], capture_output=True, text=True).stderr
    h, m, s = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out).groups()
    return int(h) * 3600 + int(m) * 60 + float(s)


def events():
    start = secs(START.read_text().strip())
    out = []
    for line in LOG.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\[(\d\d:\d\d:\d\d)\] (.*)", line)
        if m:
            out.append(((secs(m.group(1)) - start).total_seconds() + LEAD_IN, m.group(2)))
    return out


def caption_at(t, marks):
    label = "ForgePilot on TrueForge"
    for when, text in marks:
        if when <= t:
            label = text
    return label


def build_segments():
    ev = events()
    total = max(offset + length for _, offset, length in sources())
    find = lambda pat, after=0: next(t for t, txt in ev if t >= after and re.search(pat, txt))
    t_a = find(r"^Task A selection") - 2
    t_b_start = find(r"after undo")  # end of the Task A block
    t_c = find(r"^Task C|MARK fast on", find(r"Task B in --help")) - 9
    if any(txt.startswith("Cancel git status") for _, txt in ev):
        t_c = max(t_c, find(r"^Cancel git status") + 4)  # keep the cancel caption while its git status shows
    t_end = find(r"DEMO COMPLETE") + 2
    marks = [
        (t_a, "Task A \u00b7 Inline edit on the selected function \u00b7 diff review \u00b7 verify in terminal \u00b7 undo"),
        (t_b_start, "Task B \u00b7 Agent mode: one request, no files named \u00b7 context pack \u2192 agent searches \u2192 reviewed edits"),
        (find(r"^Task B diff"), "Task B \u00b7 Verify: pytest, flask config (masked), flask --help, git diff \u00b7 TrueForge session UI"),
        *([(find(r"^Cancel start") - 2, "Streaming and cancellation \u00b7 Cancel stops the TrueForge session mid-run \u00b7 nothing is half-applied")]
          if any(txt == "Cancel start" for _, txt in ev) else []),
        (t_c, "Task C \u00b7 Resilience: first model has an invalid key \u2192 automatic fallback \u2192 change rejected \u2192 git status clean"),
    ]
    fast = []
    on = None
    for t, txt in ev:
        if txt == "MARK fast on":
            on = t + 3          # keep the first seconds of the run at real speed
        elif txt == "MARK fast off" and on is not None:
            if t - 2 > on:
                fast.append((on, t - 2))
            on = None
    cuts = []
    cursor = t_a
    for a, b in fast:
        if a > cursor:
            cuts.append((cursor, a, False))
        cuts.append((a, b, True))
        cursor = b
    cuts.append((cursor, min(t_end, total), False))
    # Short thinking stretches (under a minute, e.g. Task C's fallback) stay readable at 2x;
    # only the long ones absorb the rest of the time budget.
    SHORT, SHORT_SPEED = 60, 2.0
    is_short = lambda a, b: b - a < SHORT
    normal = sum(b - a for a, b, f in cuts if not f)
    short_total = sum(b - a for a, b, f in cuts if f and is_short(a, b))
    long_total = sum(b - a for a, b, f in cuts if f and not is_short(a, b))
    budget = TARGET_SECONDS - TITLE_SECONDS - normal - short_total / SHORT_SPEED
    speed = max(2, min(MAX_FAST_SPEED, long_total / max(budget, 1)))
    normal_speed = 1.0
    if budget < long_total / MAX_FAST_SPEED:
        normal_speed = normal / (TARGET_SECONDS - TITLE_SECONDS - short_total / SHORT_SPEED - long_total / MAX_FAST_SPEED)
        speed = MAX_FAST_SPEED
    print(f"normal {normal:.0f}s at {normal_speed:.2f}x, short fast {short_total:.0f}s at 2x, long fast {long_total:.0f}s at {speed:.1f}x")

    def pick(a, b, f):
        if not f:
            return normal_speed
        return SHORT_SPEED if is_short(a, b) else speed
    return [(a, b, pick(a, b, f), caption_at(a + 0.1, marks)) for a, b, f in cuts]


def render_title(path):
    lines = [
        (FONT_BOLD, 78, "ForgePilot", -170),
        (FONT, 40, "An editor-native coding agent whose agent loop runs on TrueForge", -60),
        (FONT, 32, "VS Code extension \u00b7 TrueForge local mode \u00b7 editor tools over MCP \u00b7 tool approval drives the diff review", 10),
        (FONT, 32, "Tasks A, B and C on pallets/flask 3.1.3 \u00b7 live model calls on the free Gemini tier \u00b7 review clicks scripted", 70),
        (FONT, 30, "Team FLOWSTATE \u00b7 TM-E8DADAC3DAF \u00b7 Darshan P Pawar", 170),
    ]
    draws = ",".join(
        f"drawtext=fontfile='{f}':text='{esc(t)}':fontsize={s}:fontcolor=white:x=(w-text_w)/2:y=(h/2)+({dy})"
        for f, s, t, dy in lines)
    run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x1b2433:s=1920x1080:d={TITLE_SECONDS}:r=15",
         "-vf", draws, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(path)])


def render_cut(i, a, b, speed, caption):
    out = WORK / f"c{i:02d}.mp4"
    label = esc(caption)
    speed_tag = "" if speed == 1 else esc(f"\u00bb {round(speed, 1):g}\u00d7 speed \u00b7 model thinking") if speed >= 2 else esc(f"{speed:.1f}\u00d7")
    vf = [
        "crop=1920:1032:0:0",
        f"setpts=PTS/{speed}",
        "pad=1920:1080:0:0:color=0x1b2433",
        f"drawtext=fontfile='{FONT}':text='{label}':fontsize=26:fontcolor=white:x=24:y=1032+(48-text_h)/2",
    ]
    if speed_tag:
        vf.append(f"drawtext=fontfile='{FONT_BOLD}':text='{speed_tag}':fontsize=30:fontcolor=0xffd166:box=1:boxcolor=0x000000@0.6:boxborderw=12:x=w-text_w-30:y=20")
    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{a:.2f}", "-to", f"{b:.2f}", "-i", str(RAW), "-an",
         "-vf", ",".join(vf), "-r", "15", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", str(out)])
    return out


def sources():
    """The main recording, plus an optional continuation (raw file, start file) given as extra arguments."""
    out = [(RAW, 0.0, duration(RAW))]
    if len(sys.argv) > 6:
        extra, extra_start = Path(sys.argv[5]), Path(sys.argv[6])
        offset = (secs(extra_start.read_text().strip()) - secs(START.read_text().strip())).total_seconds()
        out.append((extra, offset, duration(extra)))
    return out


def main():
    global RAW
    segs = build_segments()
    parts = [WORK / "title.mp4"]
    render_title(parts[0])
    n = 0
    main_raw = RAW
    for a, b, speed, caption in segs:
        for src, offset, length in sources():
            lo, hi = max(a, offset), min(b, offset + length)
            if hi - lo < 0.5:
                continue
            RAW = src
            print(f"cut {n}: {src.name} {lo - offset:.1f}-{hi - offset:.1f}s x{speed:.2f} | {caption[:60]}")
            parts.append(render_cut(n, lo - offset, hi - offset, speed, caption))
            n += 1
        RAW = main_raw
    lst = WORK / "list.txt"
    lst.write_text("".join(f"file '{p.resolve().as_posix()}'\n" for p in parts))
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(OUT)])
    print(f"{OUT} {duration(OUT):.1f}s")


if __name__ == "__main__":
    main()
