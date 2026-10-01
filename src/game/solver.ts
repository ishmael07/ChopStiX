// Chopsticks is tiny (225 canonical positions), so we solve it exactly with
// retrograde analysis. Every position is WIN / LOSS / DRAW for the side to move,
// with distance-to-mate for decisive results.

import {
  applyMove,
  legalMoves,
  type Move,
  type Rules,
  type Side,
  type State,
} from './rules';

export type Outcome = 'win' | 'loss' | 'draw';
export interface Verdict {
  outcome: Outcome; // from the perspective of the side to move
  dtm: number; // plies to mate (0 for terminal / draw)
}

const canon = (s: State) => {
  const me = s.hands[s.turn];
  const op = s.hands[1 - s.turn];
  const a = Math.min(me[0], me[1]);
  const b = Math.max(me[0], me[1]);
  const c = Math.min(op[0], op[1]);
  const d = Math.max(op[0], op[1]);
  return ((a * 5 + b) * 5 + c) * 5 + d;
};

const cache = new Map<string, Map<number, Verdict>>();

function table(rules: Rules) {
  const key = JSON.stringify(rules);
  const hit = cache.get(key);
  if (hit) return hit;

  // Enumerate canonical positions with side 0 to move.
  const states: State[] = [];
  for (let a = 0; a <= 4; a++)
    for (let b = a; b <= 4; b++)
      for (let c = 0; c <= 4; c++)
        for (let d = c; d <= 4; d++)
          states.push({ hands: [[a, b], [c, d]], turn: 0 });

  const res = new Map<number, Verdict>();
  const children = new Map<number, number[]>();
  for (const s of states) {
    const k = canon(s);
    if (s.hands[0][0] + s.hands[0][1] === 0) {
      res.set(k, { outcome: 'loss', dtm: 0 });
      continue;
    }
    if (s.hands[1][0] + s.hands[1][1] === 0) {
      // Opponent already dead: unreachable as a "to move" position, treat as won.
      res.set(k, { outcome: 'win', dtm: 0 });
      continue;
    }
    children.set(k, legalMoves(rules, s).map((m) => canon(applyMove(rules, s, m))));
  }

  // Layered retrograde: each pass only uses results settled in earlier passes,
  // which makes the distances exact.
  let changed = true;
  while (changed) {
    changed = false;
    const settled: [number, Verdict][] = [];
    for (const [k, kids] of children) {
      if (res.has(k)) continue;
      const vs = kids.map((c) => res.get(c));
      const losing = vs.filter((v) => v?.outcome === 'loss') as Verdict[];
      if (losing.length) {
        settled.push([k, { outcome: 'win', dtm: Math.min(...losing.map((v) => v.dtm)) + 1 }]);
      } else if (kids.length === 0) {
        settled.push([k, { outcome: 'loss', dtm: 0 }]);
      } else if (vs.every((v) => v?.outcome === 'win')) {
        settled.push([k, { outcome: 'loss', dtm: Math.max(...vs.map((v) => v!.dtm)) + 1 }]);
      }
    }
    for (const [k, v] of settled) {
      res.set(k, v);
      changed = true;
    }
  }
  for (const k of children.keys()) if (!res.has(k)) res.set(k, { outcome: 'draw', dtm: 0 });

  cache.set(key, res);
  return res;
}

export function evaluate(rules: Rules, s: State): Verdict {
  return table(rules).get(canon(s))!;
}

/** Score of a move for the mover: higher is better. */
export function scoreMove(rules: Rules, s: State, m: Move): number {
  const v = evaluate(rules, applyMove(rules, s, m)); // opponent's perspective
  if (v.outcome === 'loss') return 1000 - v.dtm; // we win; faster is better
  if (v.outcome === 'win') return -1000 + v.dtm; // we lose; drag it out
  return 0;
}

export function rankedMoves(rules: Rules, s: State) {
  return legalMoves(rules, s)
    .map((m) => ({ move: m, score: scoreMove(rules, s, m) }))
    .sort((a, b) => b.score - a.score);
}

/** Eval in [-1, 1] for side 0 (bottom). Used by the evaluation bar. */
export function evalBar(rules: Rules, s: State): { value: number; label: string } {
  const v = evaluate(rules, s);
  const sign = s.turn === 0 ? 1 : -1;
  if (v.outcome === 'draw') return { value: 0, label: '0.0' };
  const mover = v.outcome === 'win' ? 1 : -1;
  const plies = v.dtm;
  const moves = Math.ceil(plies / 2);
  const forBottom = mover * sign;
  return {
    value: forBottom * Math.max(0.55, 1 - plies * 0.03),
    label: plies === 0 ? (forBottom > 0 ? '1-0' : '0-1') : `${forBottom > 0 ? '' : '-'}M${moves}`,
  };
}

export const sideToMove = (s: State): Side => s.turn;
