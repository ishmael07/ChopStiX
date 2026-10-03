// Elo rating, tuned the way chess sites do it.
//
// Everyone starts at 800. After a game:
//   expected = 1 / (1 + 10^((opponent - you) / 400))   // your predicted score, 0..1
//   change   = K * (actual - expected)                  // actual: win 1, draw 0.5, loss 0
// K controls how fast ratings move:
//   40 for your first 20 games (provisional, so you find your level fast)
//   20 normally
//   10 once you're 2000+ (top ratings settle down)
// Ratings never drop below 100.
//
// This file is mirrored in supabase/migrations (SQL), which is what actually
// updates ratings for signed-in players. Keep the two in sync.

export const START_RATING = 800;
export const RATING_FLOOR = 100;
export const PROVISIONAL_GAMES = 20;

export type Score = 0 | 0.5 | 1;

export function kFactor(rating: number, gamesPlayed: number) {
  if (gamesPlayed < PROVISIONAL_GAMES) return 40;
  if (rating >= 2000) return 10;
  return 20;
}

export function expectedScore(me: number, opp: number) {
  return 1 / (1 + 10 ** ((opp - me) / 400));
}

export function ratingChange(me: number, opp: number, score: Score, gamesPlayed: number) {
  const raw = Math.round(kFactor(me, gamesPlayed) * (score - expectedScore(me, opp)));
  return Math.max(RATING_FLOOR, me + raw) - me;
}

/** Plain-English odds, e.g. "You're expected to win 76% of the time". */
export const winChance = (me: number, opp: number) => Math.round(expectedScore(me, opp) * 100);

export function ratingTitle(r: number) {
  if (r >= 2200) return 'Master';
  if (r >= 1800) return 'Expert';
  if (r >= 1400) return 'Advanced';
  if (r >= 1000) return 'Intermediate';
  return 'Beginner';
}
