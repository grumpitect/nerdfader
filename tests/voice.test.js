// Unit tests for voice fix's hum detector (extension/content/voice.js), run in Node on made-up recordings: talk with
// 60 Hz hum, talk with 50 Hz hum, clean talk, music, and a synth holding notes on the 60 Hz grid. The analyser a
// page would use is computed in Node (tests/analyser.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadVoice, detect } from "./analyser.js";

const voice = loadVoice();
const RATE = 48000;

// A seeded random source, so every run hears the same recordings.
function random(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
// Soft background noise, a little darker than white, at about -60 dBFS.
function noise(samples, rand, level = 0.001) {
  let low = 0;
  for (let i = 0; i < samples.length; i++) {
    low = 0.7 * low + 0.3 * (rand() * 2 - 1);
    samples[i] += level * 2.5 * low;
  }
}
// Someone talking: a buzzy voice (pulses at a wandering pitch through three formants), in words of about a quarter
// second, sentences of 2 to 3 s, and pauses of about a second between them.
function talk(samples, rand) {
  const formants = [[500, 0.97], [1500, 0.985], [2500, 0.99]].map(([f, r]) => ({
    a1: 2 * r * Math.cos((2 * Math.PI * f) / RATE), a2: -r * r, y1: 0, y2: 0,
  }));
  let phase = 0, sentenceEnd = 0, pauseEnd = 0, t0 = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    if (t >= pauseEnd) { t0 = t; sentenceEnd = t + 2 + rand(); pauseEnd = sentenceEnd + 0.7 + rand() * 0.6; }
    const speaking = t < sentenceEnd;
    const f0 = 110 + 25 * Math.sin(2 * Math.PI * 0.6 * t) + 10 * Math.sin(2 * Math.PI * 3.1 * t);
    phase += f0 / RATE;
    let pulse = 0;
    if (phase >= 1) { phase -= 1; pulse = 1; }
    const word = Math.max(0, Math.sin(2 * Math.PI * 4 * (t - t0)));
    const x = speaking ? pulse * word : 0;
    let y = 0;
    for (const f of formants) {
      const out = x + f.a1 * f.y1 + f.a2 * f.y2;
      f.y2 = f.y1; f.y1 = out;
      y += out;
    }
    samples[i] += 0.02 * y;
  }
}
// Mains hum: the odd harmonics of 50 or 60 Hz (or of a pitch a little off that), each about 10 to 15 dB above the
// background noise, as on the clip this was made for.
function hum(samples, family, rand, level = 0.0015, pitch = family) {
  const parts = [];
  for (let h = 3; h <= 33; h += 2) parts.push({ f: pitch * h, a: level * (0.5 + rand()), p: rand() * 6.28 });
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    for (const { f, a, p } of parts) samples[i] += a * Math.sin(2 * Math.PI * f * t + p);
  }
}
// Music: chords of equal-tempered notes with a few harmonics each, changing every two seconds, over a soft pad.
function music(samples, rand) {
  const note = (n) => 440 * 2 ** ((n - 69) / 12);
  const chords = [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67], [64, 67, 71, 76], [62, 65, 69, 74]];
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE, chord = chords[Math.floor(t / 2) % chords.length];
    const env = 0.6 + 0.4 * Math.exp(-((t % 0.5) * 6));
    let y = 0;
    for (const n of chord) for (let k = 1; k <= 4; k++) y += Math.sin(2 * Math.PI * note(n) * k * t) / k;
    samples[i] += 0.02 * env * y;
  }
  noise(samples, rand, 0.003);
}
// A synth holding 180, 540 and 900 Hz, which are 60 Hz harmonics, the whole time.
function synth(samples) {
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    samples[i] += 0.05 * (Math.sin(2 * Math.PI * 180 * t) + Math.sin(2 * Math.PI * 540 * t) + Math.sin(2 * Math.PI * 900 * t));
  }
}

function recording(seconds, seed, ...parts) {
  const samples = new Float32Array(seconds * RATE), rand = random(seed);
  noise(samples, rand);
  for (const part of parts) part(samples, rand);
  return samples;
}

test("the notches: the 3rd harmonic and every odd one from 500 to 6000 Hz, 20 Hz wide above 2 kHz", () => {
  const sixty = [...voice.notches(60)];
  assert.deepEqual(sixty.map((n) => n.frequency), [180, ...Array.from({ length: 46 }, (_, i) => 60 * (9 + 2 * i))]);
  assert.deepEqual([...voice.notches(50)].map((n) => n.frequency).slice(0, 3), [150, 550, 650]);
  assert.equal(voice.notches(50).length, voice.SLOTS);
  assert.equal(sixty.find((n) => n.frequency === 1980).Q, 30);
  assert.equal(sixty.find((n) => n.frequency === 4500).Q, 225);
  // At a measured pitch every notch moves with it: the 75th harmonic of 60.04 Hz is 3 Hz above 4500.
  assert.ok(Math.abs(voice.notches(60, 60.04).find((n) => Math.round(n.frequency / 60) === 75).frequency - 4503) < 1e-9);
});

test("talk with 60 Hz hum: found as 60 Hz after about 6 s", () => {
  const r = detect(voice, recording(20, 1, talk, (s, rand) => hum(s, 60, rand)), RATE);
  assert.equal(r.answer, 60);
  assert.ok(r.at < 10, `took ${r.at} s`);
});

test("the hum's exact pitch is measured: 60.04 Hz to within 0.01 Hz", () => {
  const r = detect(voice, recording(20, 6, talk, (s, rand) => hum(s, 60, rand, 0.0015, 60.04)), RATE);
  assert.equal(r.answer, 60);
  assert.ok(Math.abs(r.pitch - 60.04) < 0.01, `measured ${r.pitch}`);
});

test("talk with 50 Hz hum: found as 50 Hz", () => {
  const r = detect(voice, recording(20, 2, talk, (s, rand) => hum(s, 50, rand)), RATE);
  assert.equal(r.answer, 50);
});

test("clean talk: no hum", () => {
  const r = detect(voice, recording(25, 3, talk), RATE, { giveUpAfter: 20 });
  assert.equal(r.answer, "none");
});

test("music: no hum", () => {
  const r = detect(voice, recording(25, 4, music), RATE, { giveUpAfter: 20 });
  assert.equal(r.answer, "none");
});

test("a synth holding notes on the 60 Hz grid: no hum", () => {
  const r = detect(voice, recording(25, 5, synth), RATE, { giveUpAfter: 20 });
  assert.equal(r.answer, "none");
});

test("silence is not counted: no answer from it, however long", () => {
  const r = detect(voice, new Float32Array(30 * RATE), RATE, { giveUpAfter: 20 });
  assert.equal(r.answer, null);
});

test("Stable Volume's counter turns lifted pauses back down, and leaves uncompressed talk nearly alone", () => {
  // Levels every 25 ms: the voice at -20 dBFS for 1 s, then a pause for 0.5 s.
  const run = (pause) => {
    const next = voice.stableVolumeCounter();
    let atPause = 0, atVoice = 0;
    for (let i = 0; i < 40 * 30; i++) {
      const inPause = i % 60 >= 40, gain = next(inPause ? pause : -20);
      if (i > 40 * 25) inPause ? (atPause = gain) : (atVoice = gain);
    }
    return { atPause, atVoice };
  };
  const lifted = run(-30);   // 10 dB below the voice, as Stable Volume leaves a pause
  assert.ok(lifted.atPause < -6 && lifted.atPause > -7.5, `pause turned down ${lifted.atPause.toFixed(1)} dB`);
  assert.ok(Math.abs(lifted.atVoice) < 1e-9, "the voice untouched");
  const plain = run(-40);   // 20 dB below: not compressed
  assert.ok(plain.atPause > -0.01, `uncompressed pause left alone (${plain.atPause.toFixed(2)} dB)`);
});
