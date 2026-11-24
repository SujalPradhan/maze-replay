import math, pathlib, random, struct, wave

SR = 48000
out = pathlib.Path(__file__).parent / "sfx"
out.mkdir(exist_ok=True)


def write(name, samples):
    peak = max(1e-9, max(abs(s) for s in samples))
    with wave.open(str(out / f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(s / peak * 0.8 * 32767)) for s in samples))


def env(i, n, attack=0.01, release=0.5):
    t = i / SR
    a = min(1, t / attack) if attack else 1
    return a * math.exp(-t / release)


def whoosh(dur=0.9):
    random.seed(7)
    n, lp, s = int(dur * SR), 0.0, []
    for i in range(n):
        k = i / n
        cutoff = 0.02 + 0.25 * math.sin(math.pi * k)
        lp += cutoff * (random.uniform(-1, 1) - lp)
        s.append(lp * math.sin(math.pi * k) ** 2)
    return s


def tone(freqs, dur, release, attack=0.004):
    n = int(dur * SR)
    return [env(i, n, attack, release) * sum(math.sin(2 * math.pi * f * i / SR) * g for f, g in freqs) for i in range(n)]


write("whoosh", whoosh())
write("pop", tone([(660, 1), (1320, 0.25)], 0.25, 0.06))
write("ding", tone([(880, 1), (1760, 0.35), (2640, 0.12)], 1.4, 0.45))
print("wrote", sorted(p.name for p in out.iterdir()))
