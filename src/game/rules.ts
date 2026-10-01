// Core Chopsticks rules engine. Pure functions, no UI.

export type Hands = [number, number]; // [left, right]
export type Side = 0 | 1; // 0 = first player, 1 = second player

export interface Rules {
  overflow: 'cutoff' | 'rollover'; // cutoff: 5+ is out. rollover: wraps past 5 (6 -> 1), exactly 5 is out
  splits: boolean; // may move fingers between your own hands
  revive: boolean; // a split may bring a dead hand back (0-4 -> 2-2)
  suicide: boolean; // a split may empty one of your hands (1-1 -> 0-2)
  mirror: boolean; // a split may just flip your hands (3-1 -> 1-3)
  selfTap: boolean; // you may tap your own other hand
}

export const CLASSIC: Rules = { overflow: 'cutoff', splits: true, revive: true, suicide: false, mirror: false, selfTap: false };
export const STREET: Rules = { overflow: 'cutoff', splits: true, revive: true, suicide: true, mirror: true, selfTap: false };
export const DEFAULT_RULES = CLASSIC;

export type ModeId = 'classic' | 'street' | 'custom';
export const MODES: Record<Exclude<ModeId, 'custom'>, { name: string; tagline: string; rules: Rules; points: string[] }> = {
  classic: {
    name: 'Classic',
    tagline: 'Standard rules',
    rules: CLASSIC,
    points: ['5 or more knocks a hand out', 'Split any number of fingers between your hands', 'Revive a dead hand by splitting onto it', 'No flipping 3-1 → 1-3, no emptying a hand'],
  },
  street: {
    name: 'Lunch Table',
    tagline: 'Recess rules',
    rules: STREET,
    points: ['5 or more knocks a hand out', 'Swap freely, even 3-1 → 1-3', 'Empty a hand on purpose: 1-1 → 0-2', 'Revive a dead hand by splitting onto it'],
  },
};

export const modeOf = (r: Rules): ModeId =>
  sameRules(r, CLASSIC) ? 'classic' : sameRules(r, STREET) ? 'street' : 'custom';
const sameRules = (a: Rules, b: Rules) => (Object.keys(b) as (keyof Rules)[]).every((k) => a[k] === b[k]);

export interface State {
  hands: [Hands, Hands];
  turn: Side;
}

export type Move =
  | { kind: 'attack'; from: 0 | 1; to: 0 | 1 }
  | { kind: 'self'; from: 0 | 1 } // tap your own other hand
  | { kind: 'split'; to: Hands };

export const initialState = (): State => ({
  hands: [
    [1, 1],
    [1, 1],
  ],
  turn: 0,
});

export const other = (s: Side): Side => (s === 0 ? 1 : 0);

export const isDead = (h: Hands) => h[0] === 0 && h[1] === 0;

export function winner(s: State): Side | null {
  if (isDead(s.hands[0])) return 1;
  if (isDead(s.hands[1])) return 0;
  return null;
}

export function hitValue(rules: Rules, target: number, attacker: number) {
  const sum = target + attacker;
  if (rules.overflow === 'cutoff') return sum >= 5 ? 0 : sum;
  return sum % 5;
}

export function splitOptions(rules: Rules, h: Hands): Hands[] {
  if (!rules.splits) return [];
  const total = h[0] + h[1];
  const out: Hands[] = [];
  for (let l = 0; l <= 4; l++) {
    const r = total - l;
    if (r < 0 || r > 4) continue;
    if (l === h[0] && r === h[1]) continue; // no-op
    if (!rules.mirror && l === h[1] && r === h[0]) continue; // mere flip
    if (!rules.suicide && (l === 0 || r === 0)) continue;
    if (!rules.revive && ((h[0] === 0 && l > 0) || (h[1] === 0 && r > 0))) continue;
    out.push([l, r]);
  }
  return out;
}

export function legalMoves(rules: Rules, s: State): Move[] {
  if (winner(s) !== null) return [];
  const me = s.hands[s.turn];
  const opp = s.hands[other(s.turn)];
  const moves: Move[] = [];
  for (const from of [0, 1] as const) {
    if (me[from] === 0) continue;
    for (const to of [0, 1] as const) {
      if (opp[to] === 0) continue;
      moves.push({ kind: 'attack', from, to });
    }
    if (rules.selfTap && me[1 - from] > 0) moves.push({ kind: 'self', from });
  }
  for (const to of splitOptions(rules, me)) moves.push({ kind: 'split', to });
  return moves;
}

export function applyMove(rules: Rules, s: State, m: Move): State {
  const hands: [Hands, Hands] = [[...s.hands[0]] as Hands, [...s.hands[1]] as Hands];
  const me = s.turn;
  const opp = other(me);
  if (m.kind === 'attack') hands[opp][m.to] = hitValue(rules, hands[opp][m.to], hands[me][m.from]);
  else if (m.kind === 'self') hands[me][1 - m.from] = hitValue(rules, hands[me][1 - m.from], hands[me][m.from]);
  else hands[me] = [...m.to] as Hands;
  return { hands, turn: opp };
}

export const sameMove = (a: Move, b: Move) => JSON.stringify(a) === JSON.stringify(b);

const H = ['L', 'R'];
/** Notation: "LxR" = my left taps their right. "L+R" = my left taps my right. "S2·3" = split to 2|3. */
export function notate(m: Move): string {
  if (m.kind === 'attack') return `${H[m.from]}x${H[m.to]}`;
  if (m.kind === 'self') return `${H[m.from]}+${H[1 - m.from]}`;
  return `S${m.to[0]}·${m.to[1]}`;
}

export const positionKey = (s: State) => `${s.hands[0][0]}${s.hands[0][1]}${s.hands[1][0]}${s.hands[1][1]}${s.turn}`;

export function describeRules(r: Rules) {
  const mode = modeOf(r);
  if (mode !== 'custom') return MODES[mode].name;
  const parts = ['Custom', r.overflow === 'cutoff' ? 'Cutoff' : 'Rollover'];
  if (!r.splits) parts.push('No splits');
  if (r.selfTap) parts.push('Self-taps');
  return parts.join(' · ');
}
