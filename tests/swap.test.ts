// The custom "swap matching hands" rule, checked in the TS engine and the SQL migration.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMove, CLASSIC, initialState, isSwap, legalMoves, modeOf, positionKey, splitOptions, winner, type Move, type Rules, type State } from '../src/game/rules';
import { rankedMoves } from '../src/game/solver';

const SWAP: Rules = { ...CLASSIC, swap: true };
const sql = (f: string) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8');

/** Shortest line of play (no swaps) from the start to a position matching `goal`. */
function lineTo(goal: (s: State) => boolean): { moves: Move[]; state: State } {
  const queue = [{ moves: [] as Move[], state: initialState() }];
  const seen = new Set([positionKey(queue[0].state)]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (goal(cur.state)) return cur;
    for (const m of legalMoves(SWAP, cur.state)) {
      if (isSwap(cur.state, m)) continue;
      const next = applyMove(SWAP, cur.state, m);
      if (winner(next) !== null || seen.has(positionKey(next))) continue;
      seen.add(positionKey(next));
      queue.push({ moves: [...cur.moves, m], state: next });
    }
  }
  throw new Error('unreachable');
}
const matching = (h: [number, number]) => h[0] === h[1] && h[0] > 0;

describe('swap rule (engine)', () => {
  it('lets matching hands swap only when the rule is on', () => {
    expect(splitOptions(CLASSIC, [3, 3])).not.toContainEqual([3, 3]);
    expect(splitOptions(SWAP, [3, 3])).toContainEqual([3, 3]);
    expect(splitOptions(SWAP, [3, 1])).not.toContainEqual([3, 1]);
    expect(splitOptions({ ...SWAP, splits: false }, [3, 3])).toEqual([]);
  });
  it('keeps the named modes when the field is missing', () => {
    expect(modeOf(CLASSIC)).toBe('classic');
    expect(modeOf(SWAP)).toBe('custom');
  });
  it('is recognised and solvable', () => {
    const s: State = { hands: [[3, 3], [1, 2]], turn: 0 };
    expect(legalMoves(SWAP, s).find((m) => isSwap(s, m))).toEqual({ kind: 'split', to: [3, 3] });
    expect(rankedMoves(SWAP, s)).toHaveLength(legalMoves(SWAP, s).length);
  });
});

describe('swap rule (server)', () => {
  const db = new PGlite();
  beforeAll(async () => {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;`);
    for (const f of ['0001_init.sql', '0002_quick_play.sql', '0003_daily.sql', '0005_swap.sql']) await db.exec(sql(f));
  });
  const replay = (rules: Rules, moves: Move[]) => db.query<{ r: { plies: number; threefold: boolean } }>('select cx_replay($1, $2) r', [rules, JSON.stringify(moves)]);

  it('accepts a swap with the rule and rejects it without', async () => {
    const { moves, state } = lineTo((s) => matching(s.hands[s.turn]));
    const all = [...moves, { kind: 'split', to: [...state.hands[state.turn]] } as Move];
    expect((await replay(SWAP, all)).rows[0].r.plies).toBe(all.length);
    await expect(replay(CLASSIC, all)).rejects.toThrow(/illegal split/);
    const h = [1, 1, 1, 1];
    // cx_step agrees
    await expect(db.query('select cx_step($1, $2::int[], 0, $3)', [SWAP, h, { kind: 'split', to: [1, 1] }])).resolves.toBeTruthy();
    await expect(db.query('select cx_step($1, $2::int[], 0, $3)', [CLASSIC, h, { kind: 'split', to: [1, 1] }])).rejects.toThrow(/illegal split/);
  });

  it('ends endless swapping as a threefold draw', async () => {
    const { moves, state } = lineTo((s) => matching(s.hands[0]) && matching(s.hands[1]));
    const swaps: Move[] = [];
    let s = state;
    for (let i = 0; i < 4; i++) {
      const m: Move = { kind: 'split', to: [...s.hands[s.turn]] as [number, number] };
      swaps.push(m);
      s = applyMove(SWAP, s, m);
    }
    expect((await replay(SWAP, [...moves, ...swaps])).rows[0].r.threefold).toBe(true);
  });
});
