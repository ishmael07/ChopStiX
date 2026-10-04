// Quick play: matchmaking and server-run games, on the real migrations in PGlite.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMove, CLASSIC, initialState, legalMoves, winner, type Move } from '../src/game/rules';

const db = new PGlite();
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const as = (uid: string | null) => db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ''}', false)`);
const call = async <T = Match,>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(`select ${sql} r`, params)).rows[0].r;

interface Match {
  id: string;
  player_a: string;
  player_b: string;
  moves: Move[];
  status: string;
  winner: number | null;
  reason: string | null;
  clock_a_ms: number;
  clock_b_ms: number;
  a_delta: number | null;
  b_delta: number | null;
  next_match: string | null;
  players: { display_name: string }[];
}

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  for (const f of ['0001_init.sql', '0002_quick_play.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'));
  await db.query(`insert into auth.users values ($1, '{"username":"ann"}'), ($2, '{"username":"bob"}'), ($3, '{"username":"cat"}')`, [A, B, C]);
});

/** Side 0 knocks side 1 out. */
function knockoutGame(): Move[] {
  let s = initialState();
  const moves: Move[] = [];
  while (winner(s) === null) {
    const ms = legalMoves(CLASSIC, s);
    const m = ms.find((x) => x.kind === 'attack' && applyMove(CLASSIC, s, x).hands[1 - s.turn].some((h) => h === 0)) ?? ms.find((x) => x.kind === 'attack')!;
    moves.push(m);
    s = applyMove(CLASSIC, s, m);
  }
  return moves;
}

async function matchAB(): Promise<Match> {
  // Earlier games here are rated with random sides, which can push the two apart past the instant-match window.
  await db.query(`update profiles set rating = 800 where id in ($1, $2)`, [A, B]);
  await as(A);
  expect((await call<{ status: string }>(`find_match('classic', 60)`)).status).toBe('queued');
  await as(B);
  const res = await call<{ status: string; match: Match }>(`find_match('classic', 60)`);
  expect(res.status).toBe('matched');
  return res.match;
}
const by = (m: Match, side: number) => (side === 0 ? m.player_a : m.player_b);
const move = async (m: Match, ply: number, mv: Move) => {
  await as(by(m, ply % 2));
  return call(`play_move($1, $2, $3)`, [m.id, ply, JSON.stringify(mv)]);
};
const age = (id: string, ms: number) => db.query(`update matches set last_move_at = clock_timestamp() - make_interval(secs => $2::float / 1000) where id = $1`, [id, ms]);

describe('matchmaking', () => {
  it('pairs two players waiting for the same game', async () => {
    const m = await matchAB();
    expect([m.player_a, m.player_b].sort()).toEqual([A, B]);
    expect(m.players.map((p) => p.display_name).sort()).toEqual(['ann', 'bob']);
    // the first player finds the game on their next poll
    await as(A);
    const again = await call<{ status: string; match: Match }>(`find_match('classic', 60)`);
    expect(again.match.id).toBe(m.id);
    await as(A);
    await call(`resign_match($1)`, [m.id]); // aborted: nobody moved
  });

  it('keeps different time controls apart and drops players who stop polling', async () => {
    await as(A);
    await call(`find_match('classic', 30)`);
    await as(C);
    expect((await call<{ status: string }>(`find_match('classic', 180)`)).status).toBe('queued');
    await db.query(`update match_queue set last_seen = now() - interval '1 minute' where user_id = $1`, [C]);
    await as(B);
    expect((await call<{ status: string }>(`find_match('classic', 180)`)).status).toBe('queued');
    await as(A);
    await call(`leave_queue()`);
    await as(B);
    await call(`leave_queue()`);
    expect((await db.query(`select * from match_queue`)).rows).toHaveLength(0);
  });

  it('refuses players who are signed out', async () => {
    await as(null);
    await expect(db.query(`select find_match('classic', 60)`)).rejects.toThrow(/sign in/);
  });
});

describe('server-run games', () => {
  it('plays a game to knockout and rates both players', async () => {
    const m = await matchAB();
    const moves = knockoutGame();
    let r = m;
    for (let i = 0; i < moves.length; i++) r = await move(m, i, moves[i]);
    expect(r).toMatchObject({ status: 'finished', winner: 0, reason: 'knockout' });
    expect(r.a_delta).toBeGreaterThan(0);
    expect(r.b_delta).toBeLessThan(0);
    const g = (await db.query<{ kind: string; winner: number }>(`select * from games where game_key = $1`, [`q-${m.id}`])).rows[0];
    expect(g).toMatchObject({ kind: 'online', winner: 0 });
  });

  it('rejects moves out of turn, out of sync, illegal, or from outsiders', async () => {
    const m = await matchAB();
    const tap = { kind: 'attack', from: 0, to: 0 };
    await as(by(m, 1));
    await expect(db.query(`select play_move($1, 0, $2)`, [m.id, JSON.stringify(tap)])).rejects.toThrow(/not your turn/);
    await as(by(m, 0));
    await expect(db.query(`select play_move($1, 3, $2)`, [m.id, JSON.stringify(tap)])).rejects.toThrow(/out of sync/);
    await expect(db.query(`select play_move($1, 0, $2)`, [m.id, JSON.stringify({ kind: 'split', to: [1, 1] })])).rejects.toThrow(/illegal split/);
    await as(C);
    await expect(db.query(`select play_move($1, 0, $2)`, [m.id, JSON.stringify(tap)])).rejects.toThrow(/not playing/);
    const r = await move(m, 0, { ...tap, junk: 'x' } as Move);
    expect(r.moves).toEqual([tap]);
    await as(by(m, 1));
    await call(`resign_match($1)`, [m.id]); // still aborts: only one side has moved
  });

  it('runs the clocks on the server and flags whoever runs out', async () => {
    const m = await matchAB();
    await move(m, 0, { kind: 'attack', from: 0, to: 0 });
    await move(m, 1, { kind: 'attack', from: 0, to: 0 });
    await age(m.id, 5000);
    const r = await move(m, 2, { kind: 'attack', from: 1, to: 1 });
    expect(r.clock_a_ms).toBeLessThanOrEqual(55000);
    expect(r.clock_a_ms).toBeGreaterThan(54000);
    expect(r.clock_b_ms).toBe(60000);

    // side 1 goes quiet; claiming early does nothing, claiming after the flag ends it
    await as(by(m, 0));
    expect((await call(`claim_timeout($1)`, [m.id])).status).toBe('active');
    await age(m.id, 61000);
    const done = await call(`claim_timeout($1)`, [m.id]);
    expect(done).toMatchObject({ status: 'finished', winner: 0, reason: 'time' });
    // a late move is refused
    await as(by(m, 1));
    await expect(db.query(`select play_move($1, 3, $2)`, [m.id, JSON.stringify({ kind: 'attack', from: 0, to: 0 })])).rejects.toThrow(/over/);
  });

  it('aborts games nobody starts, unrated', async () => {
    const m = await matchAB();
    await age(m.id, 31000);
    await as(by(m, 1));
    const r = await call(`claim_timeout($1)`, [m.id]);
    expect(r).toMatchObject({ status: 'aborted', a_delta: null });
    expect((await db.query(`select * from games where game_key = $1`, [`q-${m.id}`])).rows).toHaveLength(0);
  });

  it('counts resignation as a loss once both sides have moved', async () => {
    const m = await matchAB();
    await move(m, 0, { kind: 'attack', from: 0, to: 0 });
    await move(m, 1, { kind: 'attack', from: 0, to: 0 });
    await as(by(m, 0));
    expect(await call(`resign_match($1)`, [m.id])).toMatchObject({ status: 'finished', winner: 1, reason: 'resignation' });
  });

  it('resumes your game after a reload', async () => {
    const m = await matchAB();
    await as(A);
    expect((await call(`current_match()`)).id).toBe(m.id);
    await call(`resign_match($1)`, [m.id]);
    expect(await call(`current_match()`)).toBeNull();
  });

  it('starts a rematch with sides swapped once both ask', async () => {
    const m = await matchAB();
    await move(m, 0, { kind: 'attack', from: 0, to: 0 });
    await move(m, 1, { kind: 'attack', from: 0, to: 0 });
    await as(A);
    await call(`resign_match($1)`, [m.id]);
    expect((await call(`request_rematch($1)`, [m.id])).next_match).toBeNull();
    await as(B);
    const r = await call(`request_rematch($1)`, [m.id]);
    expect(r.next_match).not.toBeNull();
    const next = await call(`get_match($1)`, [r.next_match]);
    expect([next.player_a, next.player_b]).toEqual([m.player_b, m.player_a]);
  });
});
