"""A calm ambient pad for the demo video (original, synthesised here; no samples).

Four-chord loop (Cmaj9, Am9, Fmaj7#11, G6/9), soft additive tones with slow swells,
a gentle pluck arpeggio, and a fade in/out. Writes demo/music.wav at 44.1 kHz stereo.
    python make_music.py <seconds>
"""
import sys
import wave
from pathlib import Path

import numpy as np

RATE = 44100
LENGTH = float(sys.argv[1]) if len(sys.argv) > 1 else 230.0
BAR = 8.0  # seconds per chord
OUT = Path(__file__).with_name("music.wav")

CHORDS = [  # MIDI notes
    [48, 55, 59, 62, 64],      # Cmaj9
    [45, 52, 55, 59, 64],      # Am9
    [41, 48, 52, 57, 59],      # Fmaj7#11
    [43, 50, 52, 57, 59],      # G6/9
]


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tone(freq, dur, harmonics=(1.0, 0.35, 0.12, 0.05), detune=0.0015):
    t = np.arange(int(dur * RATE)) / RATE
    out = np.zeros_like(t)
    for k, amp in enumerate(harmonics, 1):
        for d in (-detune, detune):
            out += amp * np.sin(2 * np.pi * freq * k * (1 + d) * t + k)
    return out / (2 * sum(harmonics))


def swell(n, attack=2.5, release=3.0):
    env = np.ones(n)
    a, r = int(attack * RATE), int(release * RATE)
    env[:a] = np.sin(np.linspace(0, np.pi / 2, a)) ** 2
    env[-r:] *= np.cos(np.linspace(0, np.pi / 2, r)) ** 2
    return env


total = int(LENGTH * RATE)
left = np.zeros(total + RATE * 12)
right = np.zeros_like(left)
bar_n = int(BAR * RATE)
for i in range(int(np.ceil(LENGTH / BAR))):
    chord = CHORDS[i % len(CHORDS)]
    start = i * bar_n
    dur = BAR + 3.0  # overlap into the next chord
    for j, m in enumerate(chord):
        s = tone(hz(m), dur) * swell(int(dur * RATE)) * (0.9 if j == 0 else 0.55)
        pan = 0.5 + 0.35 * np.sin(j * 1.7)
        left[start:start + len(s)] += s * (1 - pan)
        right[start:start + len(s)] += s * pan
    # soft pluck arpeggio, one note every half second, an octave up
    for k in range(16):
        m = chord[1:][k % 4] + 12
        n = int(1.6 * RATE)
        t = np.arange(n) / RATE
        p = tone(hz(m), 1.6, harmonics=(1.0, 0.2, 0.05), detune=0.0) * np.exp(-t * 3.2) * 0.22
        p[:200] *= np.linspace(0, 1, 200)
        at = start + int(k * 0.5 * RATE)
        pan = 0.3 + 0.4 * (k % 2)
        left[at:at + n] += p * (1 - pan)
        right[at:at + n] += p * pan

stereo = np.stack([left[:total], right[:total]], axis=1)
fade_in, fade_out = int(3 * RATE), int(6 * RATE)
stereo[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
stereo[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
stereo /= np.max(np.abs(stereo)) + 1e-9
stereo *= 0.5
with wave.open(str(OUT), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes((stereo * 32767).astype(np.int16).tobytes())
print(OUT, f"{LENGTH:.1f}s")
