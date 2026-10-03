// Runs the real migration on an in-process Postgres (PGlite) with a tiny stand-in
// for Supabase's auth schema, then plays games through the SQL functions.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMove, CLASSIC, initialState, legalMoves, winner, type Move } from '../src/game/rules';
import { ratingChange } from '../src/game/rating';

const db = new PGlite();
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const as = (uid: string | null) => db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ''}', false)`);
const one = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  await db.exec(readFileSync(new URL('../supabase/migrations/0001_init.sql', import.meta.url), 'utf8'));
  await db.query(`insert into auth.users values ($1, '{"username":"ishmael","display_name":"Ishmael"}'), ($2, '{"username":"sam_1"}')`, [A, B]);
});

/** Play until someone wins: side 0 plays the first legal attack each turn. */
function knockoutGame(): Move[] {
  let s = initialState();
  const moves: Move[] = [];
  while (winner(s) === null && moves.length < 200) {
    const ms = legalMoves(CLASSIC, s);
    const m = ms.find((x) => x.kind === 'attack' && applyMove(CLASSIC, s, x).hands[1 - s.turn].some((h) => h === 0)) ?? ms.find((x) => x.kind === 'attack')!;
    moves.push(m);
    s = applyMove(CLASSIC, s, m);
  }
  return moves;
}

describe('accounts', () => {
  it('creates profiles from signup metadata', async () => {
    const p = await one<{ username: string; display_name: string; rating: number }>('select * from profiles where id = $1', [A]);
    expect(p).toMatchObject({ username: 'ishmael', display_name: 'Ishmael', rating: 800 });
    expect((await one<{ display_name: string }>('select display_name from profiles where id = $1', [B])).display_name).toBe('sam_1');
  });
  it('checks usernames case-insensitively', async () => {
    expect((await one<{ ok: boolean }>(`select username_available('ISHMAEL') ok`)).ok).toBe(false);
    expect((await one<{ ok: boolean }>(`select username_available('new_name') ok`)).ok).toBe(true);
    expect((await one<{ ok: boolean }>(`select username_available('no spaces') ok`)).ok).toBe(false);
  });
});

describe('rules replay matches the TypeScript engine', () => {
  it('finds the same winner', async () => {
    const moves = knockoutGame();
    let s = initialState();
    for (const m of moves) s = applyMove(CLASSIC, s, m);
    const r = await one<{ r: { winner: number } }>('select cx_replay($1, $2) r', [CLASSIC, JSON.stringify(moves)]);
    expect(r.r.winner).toBe(winner(s));
  });
  it('rejects illegal moves', async () => {
    await expect(db.query('select cx_replay($1, $2)', [CLASSIC, JSON.stringify([{ kind: 'split', to: [1, 1] }])])).rejects.toThrow(/illegal split/);
    await expect(db.query('select cx_replay($1, $2)', [CLASSIC, JSON.stringify([{ kind: 'attack', from: 0, to: 0 }, { kind: 'self', from: 0 }])])).rejects.toThrow(/self-tap/);
  });
});

describe('rated games', () => {
  it('Elo matches the client formula', async () => {
    for (const [me, opp, score, games] of [[800, 800, 1, 0], [800, 1200, 1, 30], [1500, 1400, 0, 25], [2100, 2000, 0.5, 50], [110, 900, 0, 40]] as const) {
      const d = (await one<{ d: number }>('select cx_elo_delta($1, $2, $3, $4) d', [me, opp, score, games])).d;
      expect(d).toBe(ratingChange(me, opp, score, games));
    }
  });

  it('records a bot win once and only when the moves prove it', async () => {
    const moves = knockoutGame(); // side 0 wins
    await as(A);
    const res = await one<{ r: { delta: number; after: number; status: string } }>(
      `select record_bot_game('bot-1', 'maple', 0::smallint, $1, $2, 'knockout') r`, [CLASSIC, JSON.stringify(moves)]);
    expect(res.r).toMatchObject({ status: 'rated', delta: 20, after: 820 });
    await expect(db.query(`select record_bot_game('bot-1', 'maple', 0::smallint, $1, $2, 'knockout')`, [CLASSIC, JSON.stringify(moves)])).rejects.toThrow(/already recorded/);
    // claiming a win on an unfinished board is refused
    await expect(db.query(`select record_bot_game('bot-2', 'maple', 0::smallint, $1, $2, 'knockout')`, [CLASSIC, JSON.stringify(moves.slice(0, 2))])).rejects.toThrow(/not finished/);
    // "resigning" only ever counts as your own loss
    const lost = await one<{ r: { delta: number } }>(`select record_bot_game('bot-3', 'maple', 0::smallint, $1, $2, 'resignation') r`, [CLASSIC, JSON.stringify(moves.slice(0, 2))]);
    expect(lost.r.delta).toBeLessThan(0);
    const p = await one<{ games: number; wins: number; losses: number; peak_rating: number }>('select * from profiles where id = $1', [A]);
    expect(p).toMatchObject({ games: 2, wins: 1, losses: 1, peak_rating: 820 });
  });

  it('rates a friend game only when both players agree', async () => {
    const moves = JSON.stringify(knockoutGame()); // side 0 wins: A is side 0
    await as(A);
    expect((await one<{ r: { status: string } }>(`select report_online_game('room-1', $1, 0::smallint, $2, $3, 0::smallint, 'knockout') r`, [B, CLASSIC, moves])).r.status).toBe('pending');
    await as(B);
    // a lying report (claims B won) is thrown out
    expect((await one<{ r: { status: string } }>(`select report_online_game('room-1', $1, 1::smallint, $2, $3, 1::smallint, 'knockout') r`, [A, CLASSIC, moves])).r.status).toBe('mismatch');

    await as(A);
    await db.query(`select report_online_game('room-2', $1, 0::smallint, $2, $3, 0::smallint, 'knockout')`, [B, CLASSIC, moves]);
    await as(B);
    const r = await one<{ r: { status: string; delta: number } }>(`select report_online_game('room-2', $1, 1::smallint, $2, $3, 0::smallint, 'knockout') r`, [A, CLASSIC, moves]);
    expect(r.r.status).toBe('rated');
    expect(r.r.delta).toBeLessThan(0);
    const g = await one<{ a_delta: number; b_delta: number; winner: number }>(`select * from games where game_key = 'room-2'`);
    expect(g.winner).toBe(0);
    expect(g.a_delta).toBeGreaterThan(0);
    expect(g.a_delta + g.b_delta).toBe(0); // provisional K is the same for both here, so it's zero-sum
    await as(A);
    expect((await one<{ r: { status: string } }>(`select report_online_game('room-2', $1, 0::smallint, $2, $3, 0::smallint, 'knockout') r`, [B, CLASSIC, moves])).r.status).toBe('rated');
  });

  it('refuses rated games when signed out', async () => {
    await as(null);
    await expect(db.query(`select record_bot_game('bot-9', 'pip', 0::smallint, $1, '[]', 'resignation')`, [CLASSIC])).rejects.toThrow(/sign in/);
  });
});
