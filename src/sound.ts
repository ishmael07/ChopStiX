// Tiny synthesized sound effects; no audio assets needed.
let ctx: AudioContext | null = null;
let muted = (() => {
  try {
    return localStorage.getItem('chopstix.muted') === '1';
  } catch {
    return false;
  }
})();

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem('chopstix.muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function blip(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0) {
  ctx ??= new AudioContext();
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur);
}

export function sfx(kind: 'tap' | 'kill' | 'split' | 'select' | 'win' | 'lose' | 'start') {
  if (muted) return;
  try {
    if (kind === 'tap') blip(180, 0.09, 'triangle', 0.35, 0.6);
    if (kind === 'select') blip(620, 0.05, 'sine', 0.08);
    if (kind === 'split') (blip(420, 0.07, 'sine', 0.12), blip(560, 0.08, 'sine', 0.1, 1, 0.06));
    if (kind === 'kill') (blip(140, 0.18, 'square', 0.12, 0.4), blip(90, 0.25, 'triangle', 0.3, 0.5));
    if (kind === 'start') (blip(523, 0.1, 'sine', 0.1), blip(784, 0.14, 'sine', 0.1, 1, 0.09));
    if (kind === 'win') [523, 659, 784, 1046].forEach((f, i) => blip(f, 0.22, 'sine', 0.12, 1, i * 0.09));
    if (kind === 'lose') [392, 330, 262].forEach((f, i) => blip(f, 0.26, 'sine', 0.1, 1, i * 0.12));
  } catch {
    /* audio blocked */
  }
}
