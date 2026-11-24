import json, sys, pathlib
import soundfile as sf
from kokoro_onnx import Kokoro

root = pathlib.Path(__file__).parent
scenes = json.loads((root / "storyboard.json").read_text())["scenes"]
cache = pathlib.Path.home() / ".cache/kokoro"
k = Kokoro(str(cache / "kokoro-v1.0.onnx"), str(cache / "voices-v1.0.bin"))
voice = sys.argv[1] if len(sys.argv) > 1 else "af_heart"
speed = float(sys.argv[2]) if len(sys.argv) > 2 else 1.05
out = root / "vo"
out.mkdir(exist_ok=True)
durations = {}
for sc in scenes:
    if not sc.get("vo"):
        continue
    samples, sr = k.create(sc["vo"], voice=voice, speed=speed, lang="en-us")
    sf.write(out / f"{sc['id']}.wav", samples, sr)
    durations[sc["id"]] = round(len(samples) / sr, 3)
    print(sc["id"], durations[sc["id"]])
(out / "vo.json").write_text(json.dumps(durations))
print("total", round(sum(durations.values()), 1), "s")
