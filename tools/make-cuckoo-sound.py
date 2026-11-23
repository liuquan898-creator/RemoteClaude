"""
合成 App 审批通知用的布谷鸟叫声（"布谷——布谷"两声），写成 WAV。
只依赖 numpy；再用 ffmpeg 转成 ogg 放进 App：

    python tools/make-cuckoo-sound.py cuckoo.wav
    ffmpeg -y -i cuckoo.wav -c:a libvorbis -q:a 5 android/app/src/main/res/raw/cuckoo.ogg

音色是带一点气声的木管音（像布谷鸟钟），每声高音短、低音长，相差一个大三度。
手机外放对 500Hz 以下出声很弱，所以音高放在 600~800Hz，再叠一点二、三次泛音。
"""
import sys
import wave

import numpy as np

RATE = 44100
HIGH = 784.0  # G5
LOW = 622.0  # 降 E5，比高音低一个大三度


def note(freq: float, dur: float, rng: np.random.Generator) -> np.ndarray:
    n = int(dur * RATE)
    t = np.arange(n) / RATE
    # 音高：起音时从高 3% 滑下来，结尾再往下掉一点，像鸟叫
    bend = 1 + 0.03 * np.exp(-t / 0.025) - 0.015 * (t / dur) ** 3
    phase = 2 * np.pi * np.cumsum(freq * bend) / RATE
    tone = np.sin(phase) + 0.28 * np.sin(2 * phase + 0.3) + 0.09 * np.sin(3 * phase + 0.7)
    # 气声：在基音附近的窄带噪声
    noise = rng.standard_normal(n)
    spec = np.fft.rfft(noise)
    f = np.fft.rfftfreq(n, 1 / RATE)
    spec *= np.exp(-(((f - freq) / 180) ** 2))
    breath = np.fft.irfft(spec, n)
    breath /= np.max(np.abs(breath)) + 1e-9
    # 包络：25ms 起音，慢慢变弱，最后 70ms 收掉
    env = np.minimum(1, t / 0.025) * np.exp(-t / (dur * 2.5))
    rel = 0.07
    env *= np.clip((dur - t) / rel, 0, 1) ** 1.5
    return (tone + 0.12 * breath) * env


def silence(dur: float) -> np.ndarray:
    return np.zeros(int(dur * RATE))


def reverb(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """短混响：0.3 秒指数衰减的噪声做冲激响应，轻轻混一点进去"""
    n = int(0.3 * RATE)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / RATE / 0.07)
    ir /= np.sqrt(np.sum(ir**2))
    size = len(x) + n - 1
    wet = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)
    dry = np.concatenate([x, np.zeros(n - 1)])
    return dry + 0.18 * wet


def main(out: str) -> None:
    rng = np.random.default_rng(7)
    call = [note(HIGH, 0.17, rng), silence(0.09), note(LOW, 0.30, rng)]
    x = np.concatenate(call + [silence(0.33)] + call + [silence(0.05)])
    x = reverb(x, rng)
    # 收尾 50ms 淡出，峰值归一到 -2dBFS
    fade = int(0.05 * RATE)
    x[-fade:] *= np.linspace(1, 0, fade)
    x *= 10 ** (-2 / 20) / np.max(np.abs(x))
    pcm = (x * 32767).astype("<i2")
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    print(f"{out}: {len(x) / RATE:.2f}s")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "cuckoo.wav")
