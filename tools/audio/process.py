"""
Build the game's sound set from CC0 sources.

    python tools/audio/process.py

Inputs:  tools/audio/raw/ (git-ignored; see tools/audio/README.md for sources + licences)
Outputs: packages/client/public/audio/*.ogg and packages/client/public/audio/manifest.json

Each clip is decoded to float samples, trimmed to its real onset (no dead air before a gunshot),
cut to a useful length with a fade-out, peak-normalised to -1 dBFS, and encoded as compact Ogg
Vorbis. One-shots are mono (ready for positional audio in M4); the rain bed stays stereo.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "tools" / "audio" / "raw"
OUT = ROOT / "packages" / "client" / "public" / "audio"
SR = 48000
FIREARMS = RAW / "firearms" / "Prepared SFX Library"
RPG = RAW / "kenney_rpg" / "Audio"
IMPACT = RAW / "kenney_impact" / "Audio"


def decode(path: Path, channels: int = 1) -> np.ndarray:
    """Decode any audio file to float32 [-1, 1], shape (n, channels)."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", str(channels), "-ar", str(SR), "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).copy()


def encode(samples: np.ndarray, dest: Path, quality: int = 5) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    ch = samples.shape[1]
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", str(ch), "-ar", str(SR), "-i", "-",
         "-c:a", "libvorbis", "-q:a", str(quality), str(dest)],
        input=samples.astype(np.float32).tobytes(),
        check=True,
    )


def onset(x: np.ndarray, threshold_db: float = -38) -> int:
    """First sample whose level crosses the threshold (relative to the clip peak)."""
    env = np.abs(x).max(axis=1)
    thresh = env.max() * 10 ** (threshold_db / 20)
    idx = np.argmax(env > thresh)
    return max(0, int(idx) - int(0.004 * SR))  # keep 4 ms of pre-attack


def loudest(x: np.ndarray, window_s: float = 0.25) -> int:
    """Centre sample of the loudest RMS window."""
    w = int(window_s * SR)
    e = (x.astype(np.float64) ** 2).mean(axis=1)
    # Sliding-window energy via a cumulative sum: linear time (a direct convolution is O(n·w)).
    c = np.concatenate(([0.0], np.cumsum(e)))
    sums = c[w:] - c[:-w]
    return int(np.argmax(sums)) + w // 2


def shape(x: np.ndarray, start: int, length_s: float, fade_s: float, fade_in_s: float = 0.0) -> np.ndarray:
    seg = x[start : start + int(length_s * SR)].copy()
    n = len(seg)
    f = min(n, int(fade_s * SR))
    if f > 0:
        seg[n - f :] *= np.linspace(1, 0, f, dtype=np.float32)[:, None] ** 2
    fi = min(n, int(fade_in_s * SR))
    if fi > 0:
        seg[:fi] *= np.linspace(0, 1, fi, dtype=np.float32)[:, None]
    return seg


def normalise(x: np.ndarray, peak_db: float = -1.0) -> np.ndarray:
    peak = np.abs(x).max()
    return x * (10 ** (peak_db / 20) / peak) if peak > 0 else x


@dataclass
class Clip:
    name: str
    src: Path
    length_s: float
    fade_s: float = 0.2
    channels: int = 1
    trim_onset: bool = True
    gain_db: float = -1.0
    start_s: float | None = None  # explicit start (overrides onset detection)


def one_shots() -> list[Clip]:
    clips = [
        # Real recorded firearms (The Free Firearm Sound Library, CC0).
        Clip("rifle_shot", FIREARMS / "AR-15" / "D_32P.wav", 1.5, 0.9),
        Clip("rifle_shot_far", FIREARMS / "AR-15" / "D_24P.wav", 2.2, 1.2),
        Clip("pistol_shot", FIREARMS / "Walther PPQ" / "X_39P.wav", 1.2, 0.7),
        Clip("pistol_shot_far", FIREARMS / "Walther PPQ" / "X_31P.wav", 1.8, 1.0),
        # Reloads (opengameart gun-reload-sounds, CC0).
        Clip("reload_rifle", RAW / "assaultriflereload1.wav", 1.6, 0.1, trim_onset=False),
        Clip("reload_pistol", RAW / "gunreload1.wav", 1.6, 0.1, trim_onset=False),
        # Explosions (opengameart, CC0).
        Clip("explosion_near", RAW / "chunky_explosion.mp3", 3.5, 2.0),
        Clip("explosion_near_2", RAW / "dynamite.wav", 3.5, 2.0),
        Clip("explosion_far", RAW / "muffled_distant_explosion.ogg", 4.0, 2.2),
        # Kenney RPG Audio (CC0): handling foley.
        Clip("knife_draw_1", RPG / "drawKnife1.ogg", 0.6, 0.1),
        Clip("knife_draw_2", RPG / "drawKnife2.ogg", 0.6, 0.1),
        Clip("knife_draw_3", RPG / "drawKnife3.ogg", 0.6, 0.1),
        Clip("knife_hit_1", RPG / "knifeSlice.ogg", 0.5, 0.1),
        Clip("knife_hit_2", RPG / "knifeSlice2.ogg", 0.5, 0.1),
        Clip("cloth_1", RPG / "cloth1.ogg", 0.7, 0.15, gain_db=-4),
        Clip("cloth_2", RPG / "cloth2.ogg", 0.7, 0.15, gain_db=-4),
        Clip("cloth_3", RPG / "cloth3.ogg", 0.7, 0.15, gain_db=-4),
        Clip("cloth_4", RPG / "cloth4.ogg", 0.7, 0.15, gain_db=-4),
        Clip("belt", RPG / "clothBelt.ogg", 0.7, 0.15, gain_db=-3),
        Clip("leather", RPG / "handleSmallLeather.ogg", 0.6, 0.12, gain_db=-3),
        Clip("metal_click", RPG / "metalClick.ogg", 0.4, 0.08),
        Clip("metal_latch", RPG / "metalLatch.ogg", 0.5, 0.1),
    ]
    # Kenney Impact Sounds (CC0): footsteps per surface + material impacts.
    for surface in ("concrete", "wood", "grass"):
        for i in range(5):
            clips.append(Clip(f"step_{surface}_{i}", IMPACT / f"footstep_{surface}_00{i}.ogg", 0.5, 0.08, gain_db=-2))
    for kind in (
        "impactMetal_light",
        "impactPlate_light",
        "impactWood_light",
        "impactPunch_heavy",
        "impactTin_medium",
        # Per-surface bullet impacts: glass, stone chips, foliage/soft, generic.
        "impactGlass_light",
        "impactMining",
        "impactSoft_medium",
        "impactGeneric_light",
    ):
        for i in range(3):
            clips.append(Clip(f"{kind}_{i}", IMPACT / f"{kind}_00{i}.ogg", 0.6, 0.1))
    return clips


def build() -> dict[str, dict[str, float]]:
    manifest: dict[str, dict[str, float]] = {}

    def emit(name: str, x: np.ndarray, quality: int = 5) -> None:
        encode(x, OUT / f"{name}.ogg", quality)
        manifest[name] = {"duration": round(len(x) / SR, 3)}

    for c in one_shots():
        x = decode(c.src, c.channels)
        start = int(c.start_s * SR) if c.start_s is not None else (onset(x) if c.trim_onset else 0)
        emit(c.name, normalise(shape(x, start, c.length_s, c.fade_s), c.gain_db))

    # Rain bed: 30 s of the loop, stereo, with a crossfaded seam so it loops without a click.
    rain = decode(RAW / "amb_rain_loop_1.ogg", 2)
    body = rain[int(5 * SR) : int(35 * SR)].copy()
    xf = int(1.5 * SR)
    ramp = np.linspace(0, 1, xf, dtype=np.float32)[:, None]
    tail = rain[int(35 * SR) : int(35 * SR) + xf]
    body[:xf] = body[:xf] * ramp + tail * (1 - ramp)
    emit("rain_loop", normalise(body, -3), quality=3)

    # Thunder: the loudest crack in the storm recording, with its rolling tail.
    storm = decode(RAW / "rain-thunder.ogg", 1)
    peak = loudest(storm, 0.5)
    emit("thunder", normalise(shape(storm, max(0, peak - int(1.2 * SR)), 7.0, 3.0, fade_in_s=0.4)))

    # Equipment clicks: split the 23 s take into its individual clicks, keep the six strongest.
    eq = decode(RAW / "equipment_clicks3.wav", 1)
    env = np.convolve(np.abs(eq[:, 0]), np.ones(480) / 480, mode="same")
    on = env > env.max() * 0.08
    edges = np.flatnonzero(np.diff(on.astype(np.int8)))
    starts = edges[::2]
    segs = sorted(
        ((env[s : s + int(0.3 * SR)].max(), int(s)) for s in starts if s + int(0.3 * SR) < len(eq)),
        reverse=True,
    )[:6]
    for i, (_, s) in enumerate(sorted(segs, key=lambda t: t[1])):
        emit(f"gear_click_{i}", normalise(shape(eq, max(0, s - 200), 0.3, 0.08), -3))

    # Voices (HaelDB "Male Grunt/Yelling sounds", CC0): four male voices. Short grunts (0.25-0.55 s
    # of voice) are hurt sounds, long cries (0.9-2.2 s) death sounds; a voice with no long cry uses
    # its two longest. Picked by measured activity, then trimmed and peak-normalised.
    voices = RAW / "voices" / "yelling sounds"
    for v, prefix in enumerate(("1yell", "2yell", "3", "yell")):
        takes = []
        for f in sorted(voices.glob(f"{prefix}*.wav")):
            x = decode(f, 1)
            env = np.abs(x[:, 0])
            idx = np.flatnonzero(env > env.max() * 0.1)
            active = (idx[-1] - idx[0]) / SR if idx.size else 0.0
            takes.append((active, f.name, x))
        hurt = [t for t in takes if 0.25 <= t[0] <= 0.55][:4]
        death = [t for t in takes if 0.9 <= t[0] <= 2.2][:2]
        if len(death) < 2:
            death = sorted(takes, key=lambda t: -t[0])[:2]
        for i, (active, _, x) in enumerate(hurt):
            emit(f"voice{v}_hurt_{i}", normalise(shape(x, onset(x), active + 0.25, 0.12), -2))
        for i, (active, _, x) in enumerate(death):
            emit(f"voice{v}_death_{i}", normalise(shape(x, onset(x), active + 0.6, 0.4), -1))

    # Breathing (mikeask "Breathing Tired", CC0): a 3 s loop with a crossfaded seam, played under
    # sprint exhaustion and low health.
    br = decode(RAW / "breathing_tired.wav", 1)
    xf = int(0.4 * SR)
    body = br[: len(br) - xf].copy()
    ramp = np.linspace(0, 1, xf, dtype=np.float32)[:, None]
    body[:xf] = body[:xf] * ramp + br[len(br) - xf :] * (1 - ramp)
    emit("breathing_loop", normalise(body, -4), quality=3)

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    m = build()
    size = sum(f.stat().st_size for f in OUT.glob("*.ogg"))
    print(f"{len(m)} clips, {size / 1048576:.2f} MB -> {OUT}")
