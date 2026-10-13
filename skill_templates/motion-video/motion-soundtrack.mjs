// Original synthesis only. Run: node motion-soundtrack.mjs
import { mkdirSync, writeFileSync } from "node:fs";

// Match these to motion-starter.html's scene list and timing.
const BPM = 120, TOTAL_BARS = 6, CUT_BARS = [0, 2, 4];
const SR = 48000, BEAT = 60 / BPM, BAR = 240 / BPM, DURATION = TOTAL_BARS * BAR;
const N = Math.round(SR * DURATION), L = new Float32Array(N), R = new Float32Array(N);
let seed = 7;
const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
const mtof = m => 440 * 2 ** ((m - 69) / 12);
function add(i, sample, pan = 0) {
  if (i >= 0 && i < N) { L[i] += sample * (1 - pan * 0.5); R[i] += sample * (1 + pan * 0.5); }
}
function voice(start, duration, synth, pan = 0) {
  const offset = Math.round(start * SR);
  for (let j = 0; j < Math.round(duration * SR); j++) add(offset + j, synth(j / SR, j), pan);
}
function kick(start, gain = 0.65) {
  let phase = 0;
  voice(start, 0.35, t => {
    phase += (48 + 140 * Math.exp(-t * 35)) / SR;
    return Math.sin(2 * Math.PI * phase) * Math.exp(-t * 12) * gain;
  });
}
function hat(start, pan) {
  let previous = 0;
  voice(start, 0.06, t => {
    const n = noise(), hp = n - previous; previous = n;
    return hp * Math.exp(-t * 70) * 0.07;
  }, pan);
}
function whoosh(cut) {
  let low = 0;
  // Rise into the cut; the kick provides the transient exactly on it.
  voice(cut - 0.35, 0.35, t => {
    const x = t / 0.35; low += (0.04 + x * x * 0.3) * (noise() - low);
    return low * Math.sin(Math.PI * x) * x * 0.45;
  }, 0.25);
}
const chords = [[48, 52, 55], [45, 48, 52], [41, 45, 48]];
for (let bar = 0; bar < TOTAL_BARS; bar++) {
  const chord = chords[Math.floor(bar / 2) % chords.length];
  for (let beat = 0; beat < 4; beat++) {
    const t = bar * BAR + beat * BEAT;
    // No hit on the very first sample: AAC turns a hard onset at 0 s into a true-peak over.
    if (t > 0) kick(t, CUT_BARS.includes(bar) && beat === 0 ? 0.85 : 0.65);
    hat(t + BEAT / 2, beat % 2 ? 0.6 : -0.6);
    const f = mtof(chord[0] - 12);
    voice(t, BEAT * 0.85, k => Math.sin(2 * Math.PI * f * k) * Math.min(1, k / 0.008) * Math.exp(-k * 6) * 0.25);
    const arp = mtof(chord[beat % 3] + 12);
    voice(t + BEAT / 2, BEAT * 0.45, k => Math.sin(2 * Math.PI * arp * k) * Math.min(1, k / 0.006) * Math.exp(-k * 18) * 0.07, beat % 2 ? 0.4 : -0.4);
  }
  chord.forEach((note, index) => {
    const f = mtof(note);
    voice(bar * BAR, BAR, t => {
      const env = Math.min(1, t / 0.08) * Math.min(1, (BAR - t) / 0.16);
      const duck = 1 - 0.5 * Math.exp(-(t % BEAT) * 16);
      return (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 1.003 * t)) * env * duck * 0.055;
    }, (index - 1) * 0.6);
  });
}
for (const bar of CUT_BARS.filter(b => b > 0)) whoosh(bar * BAR);

// Normalize the RAW floating-point mix before soft clipping, not afterwards only.
let rawPeak = 0;
for (let i = 0; i < N; i++) rawPeak = Math.max(rawPeak, Math.abs(L[i]), Math.abs(R[i]));
if (!(rawPeak > 0) || !Number.isFinite(rawPeak)) throw new Error("Synthesized mix is silent or invalid.");
const preGain = 1.1 / rawPeak;
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR, fade = Math.min(1, t / 0.03) * Math.min(1, (DURATION - t) / 0.4);
  L[i] = Math.tanh(L[i] * preGain) * fade; R[i] = Math.tanh(R[i] * preGain) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const gain = 10 ** (-1.5 / 20) / peak; // AAC headroom; renderer also normalizes LUFS.
const wav = Buffer.alloc(44 + N * 4);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + N * 4, 4); wav.write("WAVE", 8);
wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 4, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  wav.writeInt16LE(Math.round(L[i] * gain * 32767), 44 + i * 4);
  wav.writeInt16LE(Math.round(R[i] * gain * 32767), 46 + i * 4);
}
const out = new URL("./out/", import.meta.url);
mkdirSync(out, { recursive: true }); writeFileSync(new URL("soundtrack.wav", out), wav);
console.log(`out/soundtrack.wav: ${DURATION}s, ${BPM} BPM, stereo ${SR} Hz 16-bit, peak -1.5 dBFS. Measure encoded loudness before delivery.`);
