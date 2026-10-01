import { applyMove, legalMoves, winner, type Move, type Rules, type State } from './rules';
import { rankedMoves } from './solver';

export interface Bot {
  id: string;
  name: string;
  rating: number;
  blurb: string;
  accuracy: number; // probability of playing a solver-best move
  color: string;
  emoji: string;
}

export const BOTS: Bot[] = [
  { id: 'pip', name: 'Pip', rating: 400, blurb: 'Just learned the game', accuracy: 0.15, color: '#9cc46a', emoji: '🐣' },
  { id: 'maple', name: 'Maple', rating: 800, blurb: 'Spots the obvious moves', accuracy: 0.45, color: '#e3a35a', emoji: '🍁' },
  { id: 'bamboo', name: 'Bamboo', rating: 1200, blurb: 'Loves a sneaky split', accuracy: 0.7, color: '#5fae86', emoji: '🎋' },
  { id: 'kenji', name: 'Kenji', rating: 1600, blurb: 'Rarely blunders', accuracy: 0.88, color: '#d8735f', emoji: '🥋' },
  { id: 'sensei', name: 'Sensei', rating: 2400, blurb: 'Plays perfectly. Unbeatable', accuracy: 1, color: '#c8a85a', emoji: '🥢' },
];

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export function botMove(bot: Bot, rules: Rules, s: State): Move {
  const ranked = rankedMoves(rules, s);
  const best = ranked[0].score;
  const bestMoves = ranked.filter((r) => r.score === best).map((r) => r.move);

  // Even weak bots never miss a mate-in-one; it feels silly otherwise.
  const instant = legalMoves(rules, s).find((m) => winner(applyMove(rules, s, m)) !== null);
  if (instant && bot.accuracy >= 0.4) return instant;

  if (Math.random() < bot.accuracy) return pick(bestMoves);
  // Otherwise play a "human" move: prefer attacks over splits, random among them.
  const all = ranked.map((r) => r.move);
  const attacks = all.filter((m) => m.kind === 'attack');
  return Math.random() < 0.7 && attacks.length ? pick(attacks) : pick(all);
}
