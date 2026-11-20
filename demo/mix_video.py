"""Adds the narration (demo/voice), the music bed (demo/music-verb.wav) and narration subtitles
to the cut demo video.

    python mix_video.py in.mp4 out.mp4

Voice: high-pass, gentle compression, placed at each line's time. Music: ducked under the
voice with a sidechain compressor. Final loudness about -16 LUFS (YouTube-friendly).
"""
import json
import subprocess
import sys
import textwrap
from pathlib import Path

HERE = Path(__file__).resolve().parent
VIDEO, OUT = Path(sys.argv[1]), Path(sys.argv[2])
spec = {l["id"]: l for l in json.loads((HERE / "narration.json").read_text(encoding="utf-8"))["lines"]}
voices = json.loads((HERE / "voice" / "manifest.json").read_text(encoding="utf-8"))
SUBS = HERE / "cuts" / "subs"
SUBS.mkdir(parents=True, exist_ok=True)
FONT = "C\\:/Windows/Fonts/segoeui.ttf"

inputs = ["-i", str(VIDEO), "-i", str(HERE / "music-verb.wav")]
chains, labels, draws = [], [], []
# A line that runs long pushes the next one back, so two lines never overlap.
previous_end = 0.0
for v in voices:
    v["at"] = max(v["at"], previous_end + 0.35)
    previous_end = v["at"] + v["speech_s"]
    print(f"{v['id']} at {v['at']:.2f}s for {v['speech_s']:.2f}s")
for n, v in enumerate(voices):
    inputs += ["-i", str(HERE / "voice" / v["file"])]
    delay = int(v["at"] * 1000)
    chains.append(f"[{n + 2}:a]aresample=44100,highpass=f=90,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,"
                  f"volume=1.6,adelay={delay}|{delay},apad[v{n}]")
    labels.append(f"[v{n}]")
    # subtitle, wrapped to two lines at most, shown while the line plays
    text = spec[v["id"]]["text"]
    sub = SUBS / f"{v['id']}.txt"
    sub.write_text("\n".join(textwrap.wrap(text, 78)), encoding="utf-8")
    end = v["at"] + v["speech_s"] + 0.4
    draws.append(
        f"drawtext=fontfile='{FONT}':textfile='{sub.as_posix().replace(':', chr(92) + ':')}':fontsize=30:fontcolor=white:"
        f"line_spacing=8:box=1:boxcolor=0x0b1220@0.72:boxborderw=14:x=(w-text_w)/2:y=1032-text_h-34:"
        f"enable='between(t,{v['at']:.2f},{end:.2f})'")

graph = ";".join(chains)
graph += f";{''.join(labels)}amix=inputs={len(labels)}:normalize=0:duration=longest,asplit=2[voice][key]"
graph += ";[1:a]volume=0.3[bed];[bed][key]sidechaincompress=threshold=0.02:ratio=8:attack=40:release=600[ducked]"
graph += ";[voice][ducked]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
graph += ";[0:v]" + ",".join(draws) + "[vout]"

limit = ["-t", sys.argv[3]] if len(sys.argv) > 3 else []
cmd = ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
       "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "15",
       "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-shortest", *limit, "-movflags", "+faststart", str(OUT)]
subprocess.run(cmd, check=True)
print(OUT)
