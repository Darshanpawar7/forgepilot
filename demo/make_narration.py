"""Speaks demo/narration.json with Indic Parler-TTS (local, CPU) and keeps, per line, the first take
that fits its window and that Whisper hears close to the script (else the best take).

    <venv with parler_tts>/python make_narration.py [line-id ...]

Writes demo/voice/<id>.wav and demo/voice/manifest.json.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from parler_tts import ParlerTTSForConditionalGeneration
from transformers import AutoTokenizer, pipeline

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "voice"
OUT.mkdir(exist_ok=True)
MODEL = "naklitechie/indic-parler-tts"
MAX_TAKES = 3
GOOD = 0.08

torch.set_num_threads(os.cpu_count() or 4)
spec = json.loads((ROOT / "narration.json").read_text(encoding="utf-8"))
only = set(sys.argv[1:])

print("loading Indic Parler-TTS", flush=True)
model = ParlerTTSForConditionalGeneration.from_pretrained(MODEL).eval()
prompt_tok = AutoTokenizer.from_pretrained(MODEL)
desc_tok = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)
RATE = model.config.sampling_rate
ear = pipeline("automatic-speech-recognition", model="openai/whisper-small")


def plain(text):
    text = text.lower().replace("forgepilot", "forge pilot").replace("trueforge", "true forge")
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text)).strip()


def char_error(a, b):
    a, b = plain(a), plain(b)
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return row[-1] / max(len(a), 1)


def bounds(audio):
    level = np.abs(audio)
    loud = np.where(level > 0.02 * level.max())[0]
    return (int(loud[0]), int(loud[-1])) if len(loud) else (0, len(audio) - 1)


def speak(text, seed):
    torch.manual_seed(seed)
    d = desc_tok(spec["voice"], return_tensors="pt")
    p = prompt_tok(text, return_tensors="pt")
    with torch.inference_mode():
        g = model.generate(input_ids=d.input_ids, attention_mask=d.attention_mask,
                           prompt_input_ids=p.input_ids, prompt_attention_mask=p.attention_mask, do_sample=True)
    return g.cpu().numpy().squeeze().astype(np.float32)


def to_16k(audio):
    n = int(len(audio) * 16000 / RATE)
    return np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)


manifest_path = OUT / "manifest.json"
manifest = {r["id"]: r for r in json.loads(manifest_path.read_text(encoding="utf-8"))} if manifest_path.exists() else {}
for n, line in enumerate(spec["lines"]):
    if (only and line["id"] not in only) or (not only and line["id"] in manifest):
        continue
    t0 = time.time()
    takes = []
    for k in range(MAX_TAKES):
        audio = speak(line.get("say", line["text"]), 7000 + 100 * n + k)
        a, b = bounds(audio)
        audio = audio[a: b + 1]
        heard = ear({"raw": to_16k(audio), "sampling_rate": 16000}, generate_kwargs={"language": "english", "task": "transcribe"})["text"].strip()
        v = {"speech_s": round(len(audio) / RATE, 2), "error": round(char_error(line.get("say", line["text"]), heard), 3), "heard": heard}
        v["fits"] = v["speech_s"] <= line["window"]
        takes.append((audio, v))
        print(f"  {line['id']} take {k + 1}: {v['speech_s']}s of {line['window']}s, error {v['error']}: {heard}", flush=True)
        if v["fits"] and v["error"] <= GOOD:
            break
    pool = [t for t in takes if t[1]["fits"]] or takes
    audio, v = min(pool, key=lambda t: (t[1]["error"], t[1]["speech_s"]))
    sf.write(OUT / f"{line['id']}.wav", audio, RATE, subtype="PCM_16")
    manifest[line["id"]] = {"id": line["id"], "at": line["at"], "window": line["window"], "file": f"{line['id']}.wav", **v}
    manifest_path.write_text(json.dumps(sorted(manifest.values(), key=lambda r: r["at"]), indent=1), encoding="utf-8")
    print(f"{line['id']}: kept {v['speech_s']}s, error {v['error']} ({time.time() - t0:.0f}s)", flush=True)
print("done", flush=True)
