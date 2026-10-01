// Chess.com-style game review powered by the exact solver.
import { applyMove, initialState, type Move, type Rules, type State } from './rules';
import { evaluate, rankedMoves } from './solver';

export type Grade = 'brilliant' | 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export const GRADE_META: Record<Grade, { label: string; color: string; icon: string }> = {
  brilliant: { label: 'Brilliant', color: '#1baca6', icon: '!!' },
  best: { label: 'Best', color: '#81b64c', icon: '★' },
  good: { label: 'Good', color: '#95b776', icon: '✓' },
  inaccuracy: { label: 'Inaccuracy', color: '#f7c631', icon: '?!' },
  mistake: { label: 'Mistake', color: '#ffa459', icon: '?' },
  blunder: { label: 'Blunder', color: '#fa412d', icon: '??' },
};

const rank = { loss: 0, draw: 1, win: 2 } as const;

export function gradeMove(rules: Rules, before: State, m: Move): Grade {
  const ranked = rankedMoves(rules, before);
  const best = ranked[0].score;
  const mine = ranked.find(
    (r) => JSON.stringify(r.move) === JSON.stringify(m),
  )!.score;
  const prev = evaluate(rules, before).outcome;
  const after = evaluate(rules, applyMove(rules, before, m)).outcome;
  const flipped = after === 'win' ? 'loss' : after === 'loss' ? 'win' : 'draw';
  const drop = rank[prev] - rank[flipped];

  if (drop >= 2) return 'blunder';
  if (drop === 1) return prev === 'win' ? 'mistake' : 'blunder';
  if (mine === best) {
    // Only winning move among many losing/drawing ones, and it's a split: brilliant.
    const winners = ranked.filter((r) => r.score > 0).length;
    if (best > 0 && winners === 1 && ranked.length >= 3 && m.kind === 'split') return 'brilliant';
    return 'best';
  }
  // Same outcome but slower win / faster loss.
  if (best > 0 && best - mine > 4) return 'inaccuracy';
  return 'good';
}

export function reviewGame(rules: Rules, moves: Move[]) {
  let s = initialState();
  const grades: Grade[] = [];
  for (const m of moves) {
    grades.push(gradeMove(rules, s, m));
    s = applyMove(rules, s, m);
  }
  const accuracy = (side: 0 | 1) => {
    const mine = grades.filter((_, i) => i % 2 === side);
    if (!mine.length) return 100;
    const pts: Record<Grade, number> = { brilliant: 100, best: 100, good: 85, inaccuracy: 60, mistake: 30, blunder: 0 };
    return Math.round(mine.reduce((a, g) => a + pts[g], 0) / mine.length);
  };
  return { grades, accuracy: [accuracy(0), accuracy(1)] as [number, number] };
}
