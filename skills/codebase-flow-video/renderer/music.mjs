// Generates an original background track (16-bit stereo WAV) for a video: pads, bass, a soft
// arpeggio and, for lively styles, light drums. Chords change on scene boundaries so the music
// follows the story. Deterministic, no samples, nothing to license.
import { writeFileSync } from 'node:fs';

const SR = 44100;
const MOODS = {
  calm: { bpm: 84, drums: false, arp: 0.5, bright: 0.35 },
  standard: { bpm: 100, drums: false, arp: 0.8, bright: 0.5 },
  snappy: { bpm: 116, drums: true, arp: 1, bright: 0.65 },
};
// Key and progression per style preset (semitones from A4 = 440 Hz; chords as scale-degree triads).
const KEYS = {
  midnight: { root: -12, minor: true }, neural: { root: -10, minor: true }, terminal: { root: -7, minor: true }, ocean: { root: -7, minor: true },
  ledger: { root: -9, minor: false }, boardroom: { root: -9, minor: false }, clinic: { root: -4, minor: false },
  storefront: { root: -4, minor: false }, candy: { root: -2, minor: false }, daylight: { root: -9, minor: false },
};
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
const PROG = { major: [0, 4, 5, 3], minor: [0, 5, 2, 6] }; // I-V-vi-IV / i-VI-III-VII

const freq = (semi) => 440 * 2 ** (semi / 12);
// Fades the last 30 ms of a note window so a cut never clicks.
const tail = (t, len) => Math.min(1, Math.max(0, (len - t) / 0.03));
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Schroeder reverb: 4 combs + 2 allpasses, enough to glue the parts together.
function reverb(buf, mix) {
  const out = new Float32Array(buf.length);
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ d, b: new Float32Array(d), i: 0 }));
  const aps = [225, 556].map((d) => ({ d, b: new Float32Array(d), i: 0 }));
  for (let n = 0; n < buf.length; n++) {
    let s = 0;
    for (const c of combs) { const y = c.b[c.i]; c.b[c.i] = buf[n] + y * 0.8; c.i = (c.i + 1) % c.d; s += y; }
    s *= 0.25;
    for (const a of aps) { const y = a.b[a.i]; const x = s + y * 0.5; a.b[a.i] = x; a.i = (a.i + 1) % a.d; s = y - x * 0.5; }
    out[n] = buf[n] * (1 - mix) + s * mix;
  }
  return out;
}

// duration (s), boundaries: times where scenes start, style: resolved style ({ preset, motion }).
export function generateMusic(file, { duration, boundaries = [], style = {}, seed = 7 }) {
  const mood = MOODS[style.motion] || MOODS.standard;
  const key = KEYS[style.preset] || KEYS.midnight;
  const scale = key.minor ? MINOR : MAJOR;
  const prog = PROG[key.minor ? 'minor' : 'major'];
  const beat = 60 / mood.bpm, bar = beat * 4;
  const N = Math.ceil((duration + 1) * SR);
  const pad = new Float32Array(N), dry = new Float32Array(N);
  const rand = rng(seed);
  // Chord segments: change at scene boundaries, and every 2 bars inside long scenes.
  const marks = [0, ...boundaries.filter((t) => t > 0.5 && t < duration - 0.5)].sort((a, b) => a - b);
  const segs = [];
  marks.forEach((t, i) => {
    const end = marks[i + 1] ?? duration + 1;
    for (let s = t; s < end - 0.01; s += bar * 2) segs.push({ start: s, end: Math.min(end, s + bar * 2) });
  });
  const note = (deg, oct = 0) => key.root + scale[((deg % 7) + 7) % 7] + 12 * (Math.floor(deg / 7) + oct);

  segs.forEach((sg, k) => {
    const deg = prog[k % prog.length];
    const triad = [deg, deg + 2, deg + 4];
    const a = Math.floor(sg.start * SR), b = Math.min(N, Math.floor((sg.end + 0.6) * SR));
    // Pad: detuned soft saw-ish voices with slow attack and release.
    triad.forEach((d, v) => {
      const f = freq(note(d, v === 0 ? 0 : 0));
      for (const det of [-0.12, 0.12]) {
        const ff = f * 2 ** (det / 12);
        let ph = rand() * 2 * Math.PI;
        for (let n = a; n < b; n++) {
          const t = (n - a) / SR, len = sg.end - sg.start;
          const env = Math.min(1, t / 0.9) * Math.min(1, Math.max(0, (len + 0.6 - t) / 0.8));
          ph += (2 * Math.PI * ff) / SR;
          pad[n] += (Math.sin(ph) + mood.bright * 0.3 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph)) * env * 0.045;
        }
      }
    });
    // Bass on the root, one note per beat pair.
    const root = freq(note(deg, -1));
    for (let t0 = sg.start; t0 < sg.end - 0.05; t0 += beat * 2) {
      const s0 = Math.floor(t0 * SR), s1 = Math.min(N, s0 + Math.floor(beat * 2 * SR));
      for (let n = s0; n < s1; n++) {
        const t = (n - s0) / SR;
        const env = Math.min(1, t / 0.02) * Math.exp(-t * 1.6) * tail(t, beat * 2);
        dry[n] += Math.sin(2 * Math.PI * root * t) * env * 0.16;
      }
    }
    // Arpeggio: chord tones an octave up, eighth notes, plucked.
    if (mood.arp > 0) {
      const pattern = [0, 1, 2, 1, 0, 2, 1, 2];
      let i = 0;
      for (let t0 = sg.start + beat * 0.5; t0 < sg.end - 0.05; t0 += beat / 2, i++) {
        if (mood.arp < 1 && i % 2) continue;
        const f = freq(note(triad[pattern[i % 8]], 1));
        const s0 = Math.floor(t0 * SR), s1 = Math.min(N, s0 + Math.floor(0.6 * SR));
        for (let n = s0; n < s1; n++) {
          const t = (n - s0) / SR;
          const env = Math.min(1, t / 0.004) * Math.exp(-t * 7) * tail(t, 0.6);
          pad[n] += (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * env * 0.05 * mood.arp;
        }
      }
    }
  });
  // Drums for lively styles: soft kick on 1 and 3, closed hat on off-beats.
  if (mood.drums) {
    for (let t0 = bar; t0 < duration - bar; t0 += beat) {
      const s0 = Math.floor(t0 * SR);
      const beatIdx = Math.round(t0 / beat) % 4;
      if (beatIdx === 0 || beatIdx === 2) {
        for (let n = s0, ph = 0; n < Math.min(N, s0 + 0.3 * SR); n++) {
          const t = (n - s0) / SR; ph += (2 * Math.PI * (45 + 90 * Math.exp(-t * 30))) / SR;
          dry[n] += Math.sin(ph) * Math.exp(-t * 9) * 0.22 * tail(t, 0.3);
        }
      }
      const h0 = Math.floor((t0 + beat / 2) * SR);
      let lp = 0;
      for (let n = h0; n < Math.min(N, h0 + 0.05 * SR); n++) {
        const t = (n - h0) / SR, x = rand() * 2 - 1; const hp = x - lp; lp = x;
        dry[n] += hp * Math.exp(-t * 90) * 0.018 * tail(t, 0.05);
      }
    }
  }
  const wet = reverb(pad, 0.35);
  // Stereo: pad slightly wide via a short delay on the right channel; master limiter.
  const dly = Math.floor(0.012 * SR);
  const out = Buffer.alloc(N * 4);
  let peak = 0;
  for (let n = 0; n < N; n++) peak = Math.max(peak, Math.abs(wet[n] + dry[n]));
  const gain = peak > 0 ? 0.85 / peak : 1;
  for (let n = 0; n < N; n++) {
    const l = Math.tanh((wet[n] + dry[n]) * gain), r = Math.tanh(((n >= dly ? wet[n - dly] : 0) + dry[n]) * gain);
    out.writeInt16LE(Math.round(l * 32000), n * 4);
    out.writeInt16LE(Math.round(r * 32000), n * 4 + 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + out.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(SR, 24);
  hdr.writeUInt32LE(SR * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(out.length, 40);
  writeFileSync(file, Buffer.concat([hdr, out]));
  return file;
}
