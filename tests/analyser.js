// What an AnalyserNode (smoothing 0) reports, computed in Node so the hum detector can be tested on samples: the
// last fftSize samples, a Blackman window, the magnitude of each bin divided by fftSize, in dB. Also loads
// extension/content/voice.js the way a page does.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export function loadVoice() {
  const code = fs.readFileSync(fileURLToPath(new URL("../extension/content/voice.js", import.meta.url)), "utf8");
  return vm.runInNewContext(`${code}\n;globalThis[Symbol.for("nerdfader.voice")]`, {});
}

export function analyser(fftSize) {
  const window = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const x = i / fftSize;
    window[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
  }
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  const bits = Math.log2(fftSize);
  const reversed = new Uint32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  const spectrum = new Float32Array(fftSize / 2);
  // samples: the fftSize samples ending now. Returns { spectrum, rms } (rms in dBFS).
  return (samples) => {
    let sum = 0;
    for (let i = 0; i < fftSize; i++) {
      sum += samples[i] * samples[i];
      re[reversed[i]] = samples[i] * window[i];
      im[reversed[i]] = 0;
    }
    for (let size = 2; size <= fftSize; size *= 2) {
      const half = size / 2, step = (-2 * Math.PI) / size;
      for (let start = 0; start < fftSize; start += size) {
        for (let k = 0; k < half; k++) {
          const c = Math.cos(step * k), s = Math.sin(step * k);
          const a = start + k, b = a + half;
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let k = 0; k < fftSize / 2; k++) spectrum[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / fftSize);
    return { spectrum, rms: 10 * Math.log10(sum / fftSize) };
  };
}

// Runs the detector over mono samples like main.js does (a frame every 100 ms of playback); returns the answer and
// when it came, in seconds of playback.
export function detect(voice, samples, sampleRate, options = {}) {
  const fftSize = 16384, hop = Math.round(sampleRate * 0.1);
  const detector = voice.humDetector({ sampleRate, fftSize, ...options });
  const read = analyser(fftSize);
  for (let end = fftSize; end <= samples.length; end += hop) {
    const { spectrum, rms } = read(samples.subarray(end - fftSize, end));
    const answer = detector.frame(spectrum, rms);
    if (answer !== null) return { answer, at: end / sampleRate, quietLevel: detector.quietLevel, pitch: detector.pitch };
  }
  return { answer: null, at: samples.length / sampleRate };
}
