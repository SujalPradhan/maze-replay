import json, pathlib, re
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

root = pathlib.Path(__file__).parent
spec = json.loads((root / "script.json").read_text())
cache = pathlib.Path.home() / ".cache/kokoro"
k = Kokoro(str(cache / "kokoro-v1.0.onnx"), str(cache / "voices-v1.0.bin"))


def syllables(w):
    w = re.sub(r"[^a-z]", "", w.lower())
    n = len(re.findall(r"[aeiouy]+", w))
    if w.endswith("e") and n > 1 and not w.endswith("le"):
        n -= 1
    return max(1, n)


def speech_spans(x, sr, floor_db=-35, min_gap=0.15):
    hop = int(sr * 0.01)
    rms = np.sqrt(np.convolve(x ** 2, np.ones(hop) / hop, "same"))[::hop]
    on = 20 * np.log10(rms + 1e-9) > floor_db
    spans, start, quiet = [], None, 0
    for i, v in enumerate(on):
        if v:
            if start is None:
                start = i
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet * 0.01 >= min_gap:
                spans.append((start * 0.01, (i - quiet + 1) * 0.01))
                start, quiet = None, 0
    if start is not None:
        spans.append((start * 0.01, len(on) * 0.01))
    return spans


lead = 4 / 30
parts, timeline, t = [np.zeros(int(24000 * lead), np.float32)], [], lead
for b in spec["beats"]:
    x, sr = k.create(b["vo"], voice=spec["voice"], speed=spec["speed"], lang="en-us")
    x = x.astype(np.float32)
    spans = speech_spans(x, sr)
    words = b["vo"].split()
    syl = [syllables(w) for w in words]
    total_speech = sum(e - s for s, e in spans) or len(x) / sr
    per = total_speech / sum(syl)
    out, si, acc = [], 0, 0.0
    flat = [(s, e) for s, e in spans] or [(0, len(x) / sr)]
    cursor, span_i = flat[0][0], 0
    for w, n in zip(words, syl):
        d = n * per
        while span_i < len(flat) - 1 and cursor + d * 0.5 > flat[span_i][1]:
            span_i += 1
            cursor = max(cursor, flat[span_i][0])
        out.append({"w": re.sub(r"[^\w'-]", "", w).lower(), "t": round(t + cursor, 3)})
        cursor += d
    dur = len(x) / sr
    timeline.append({"id": b["id"], "t": round(t, 3), "end": round(t + dur, 3), "words": out})
    parts += [x, np.zeros(int(sr * spec["gap_s"]), np.float32)]
    t += dur + spec["gap_s"]
    print(f"{b['id']:8} {dur:5.2f}s  {len(spans)} spans")
audio = np.concatenate(parts)
(root / "build").mkdir(exist_ok=True)
sf.write(root / "build" / "voice.wav", audio, 24000)
(root / "build" / "timing.json").write_text(json.dumps({"beats": timeline, "voice_end": round(t - spec["gap_s"], 3)}, indent=1))
print("voice ends", round(t - spec["gap_s"], 2), "s")
