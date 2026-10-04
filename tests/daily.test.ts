// Puzzles, streaks, friends, challenges, leaderboards, badges and chat, on the real migrations in PGlite.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMove, CLASSIC, legalMoves, winner, type Hands, type Move, type Rules, type State } from '../src/game/rules';
import { evaluate, rankedMoves } from '../src/game/solver';

const db = new PGlite();
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const as = (uid: string | null) => db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ''}', false)`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async <T = any,>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(`select ${sql} r`, params)).rows[0].r;

interface Puzzle {
  id: number;
  mode: string;
  rules: Rules;
  hands: [Hands, Hands];
  moves: number;
  rating: number;
}

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  for (const f of ['0001_init.sql', '0002_quick_play.sql', '0003_daily.sql', '0004_puzzle_data.sql'])
    await db.exec(readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'));
  await db.query(`insert into auth.users values ($1, '{"username":"ann"}'), ($2, '{"username":"bob"}'), ($3, '{"username":"cat"}')`, [A, B, C]);
});

/** Solve a puzzle the way the app does: your fastest win, their toughest defence. `wrongAt` plays a bad move there instead. */
function solve(p: Puzzle, wrongAt = -1): Move[] {
  let s: State = { hands: p.hands, turn: 0 };
  const moves: Move[] = [];
  while (winner(s) === null) {
    const ranked = rankedMoves(p.rules, s);
    let m = ranked[0].move;
    if (moves.length === wrongAt) m = ranked.find((r) => r.score < ranked[0].score)!.move;
    moves.push(m);
    s = applyMove(p.rules, s, m);
    if (moves.length - 1 === wrongAt) break;
  }
  return moves;
}

describe('the solver in SQL', () => {
  it('agrees with the TypeScript solver on every position', async () => {
    const rows = (await db.query<{ mode: string; k: number; outcome: string; dtm: number }>(`select * from cx_solver`)).rows;
    expect(rows).toHaveLength(225 * 5);
    for (let a = 0; a <= 4; a++)
      for (let b = 0; b <= 4; b++)
        for (const turn of [0, 1] as const) {
          const s: State = { hands: turn ? [[2, 3], [a, b]] : [[a, b], [2, 3]], turn };
          const k = await call<number>(`cx_canon($1, $2)`, [[...s.hands[0], ...s.hands[1]], turn]);
          const row = rows.find((r) => r.mode === 'classic' && r.k === k)!;
          expect({ outcome: row.outcome, dtm: row.dtm }).toEqual(evaluate(CLASSIC, s));
        }
  });

  it('steps moves exactly like the rules engine, for every variant', async () => {
    const variants = (await db.query<{ rules: Rules }>(`select distinct on (mode) rules from puzzles`)).rows.map((r) => r.rules);
    for (const rules of variants) {
      let s: State = { hands: [[1, 1], [1, 1]], turn: 0 };
      for (let i = 0; i < 30 && winner(s) === null; i++) {
        const ms = legalMoves(rules, s);
        const m = ms[(i * 7) % ms.length];
        const next = applyMove(rules, s, m);
        const h = await call<number[]>(`cx_step($1, $2, $3, $4)`, [rules, [...s.hands[0], ...s.hands[1]], s.turn, JSON.stringify(m)]);
        expect(h).toEqual([...next.hands[0], ...next.hands[1]]);
        s = next;
      }
    }
  });
});

describe('puzzles', () => {
  it('has a sensible pool', async () => {
    const n = await call<number>(`(select count(*)::int from puzzles)`);
    expect(n).toBeGreaterThan(100);
  });

  it('rates your first try, then lets you practise', async () => {
    await as(A);
    const p = await call<Puzzle>(`next_puzzle()`);
    const res = await call(`submit_puzzle($1, $2)`, [p.id, JSON.stringify(solve(p))]);
    expect(res).toMatchObject({ solved: true, status: 'rated' });
    expect(res.delta).toBeGreaterThan(0);
    const again = await call(`submit_puzzle($1, $2)`, [p.id, JSON.stringify(solve(p))]);
    expect(again).toMatchObject({ solved: true, status: 'practice', delta: 0 });
    // next_puzzle skips ones you've tried
    for (let i = 0; i < 5; i++) expect((await call<Puzzle>(`next_puzzle()`)).id).not.toBe(p.id);
  });

  it('fails a slower or losing move, and refuses a made-up defence', async () => {
    await as(B);
    const p = await call<Puzzle>(`next_puzzle()`);
    const res = await call(`submit_puzzle($1, $2)`, [p.id, JSON.stringify(solve(p, 0))]);
    expect(res).toMatchObject({ solved: false, status: 'rated' });
    expect(res.delta).toBeLessThan(0);

    const longer = (await db.query<Puzzle>(`select * from puzzles where moves >= 2 order by id limit 1`)).rows[0];
    const line = solve(longer);
    const s1 = applyMove(longer.rules, { hands: longer.hands, turn: 0 }, line[0]);
    const weak = rankedMoves(longer.rules, s1).find((r) => r.score < rankedMoves(longer.rules, s1)[0].score);
    if (weak) await expect(db.query(`select submit_puzzle($1, $2)`, [longer.id, JSON.stringify([line[0], weak.move])])).rejects.toThrow(/not the reply/);
    await expect(db.query(`select submit_puzzle($1, $2)`, [longer.id, JSON.stringify(line.slice(0, 1))])).rejects.toThrow(/not finished/);
  });

  it('builds a daily streak, and breaks it after a missed day', async () => {
    await as(C);
    const d = await call<{ puzzle: Puzzle; streak: number; solved_today: boolean }>(`daily_puzzle()`);
    expect((await call(`daily_puzzle()`)).puzzle.id).toBe(d.puzzle.id); // same puzzle all day
    expect(d).toMatchObject({ streak: 0, solved_today: false });
    expect(await call(`submit_puzzle($1, $2)`, [d.puzzle.id, JSON.stringify(solve(d.puzzle))])).toMatchObject({ daily: true, streak: 1 });

    await db.query(`update profiles set last_daily = cx_today() - 1, daily_streak = 4 where id = $1`, [C]);
    expect(await call(`submit_puzzle($1, $2)`, [d.puzzle.id, JSON.stringify(solve(d.puzzle))])).toMatchObject({ streak: 5, best_streak: 5 });
    expect(await call(`submit_puzzle($1, $2)`, [d.puzzle.id, JSON.stringify(solve(d.puzzle))])).toMatchObject({ streak: 5 }); // once a day

    await db.query(`update profiles set last_daily = cx_today() - 3 where id = $1`, [C]);
    expect((await call(`daily_puzzle()`)).streak).toBe(0);
    expect(await call(`submit_puzzle($1, $2)`, [d.puzzle.id, JSON.stringify(solve(d.puzzle))])).toMatchObject({ streak: 1, best_streak: 5 });
  });

  it('lets guests play without saving anything', async () => {
    await as(null);
    const p = await call<Puzzle>(`next_puzzle()`);
    expect(await call(`submit_puzzle($1, $2)`, [p.id, JSON.stringify(solve(p))])).toMatchObject({ solved: true, status: 'guest' });
  });
});

describe('friends and challenges', () => {
  it('becomes friends when both ask', async () => {
    await as(A);
    expect(await call(`friend_request($1)`, [B])).toBe('outgoing');
    expect((await call(`friends_list()`))[0]).toMatchObject({ username: 'bob', status: 'outgoing' });
    await as(B);
    expect((await call(`heartbeat()`)).friend_requests).toBe(1);
    expect((await call(`friends_list()`))[0]).toMatchObject({ username: 'ann', status: 'incoming', online: false });
    expect(await call(`friend_request($1)`, [A])).toBe('friends');
    await as(A);
    expect((await call(`friends_list()`))[0]).toMatchObject({ status: 'friends', online: true }); // bob's heartbeat
  });

  it('only lets friends challenge each other, and starts a game on accept', async () => {
    await as(C);
    await expect(db.query(`select challenge_friend($1, 'classic', 60)`, [A])).rejects.toThrow(/only challenge friends/);
    await as(A);
    const id = await call<string>(`challenge_friend($1, 'classic', 60)`, [B]);
    await as(B);
    const hb = await call(`heartbeat()`);
    expect(hb.challenges).toHaveLength(1);
    expect(hb.challenges[0]).toMatchObject({ id, clock: 60, from: { username: 'ann' } });
    const match = await call(`respond_challenge($1, true)`, [id]);
    expect([match.player_a, match.player_b].sort()).toEqual([A, B]);
    await as(A);
    expect((await call(`heartbeat()`)).sent).toMatchObject({ status: 'accepted', match: { id: match.id } });
    await expect(db.query(`select respond_challenge($1, true)`, [id])).rejects.toThrow(/expired/);
    await call(`resign_match($1)`, [match.id]);
  });

  it('unfriends', async () => {
    await as(C);
    await call(`friend_request($1)`, [A]);
    await call(`friend_remove($1)`, [A]);
    expect(await call(`friends_list()`)).toEqual([]);
  });
});

describe('leaderboards and badges', () => {
  it('ranks players by rating, weekly gains, puzzles, streaks and friends', async () => {
    await db.query(`update profiles set rating = 900, games = 3, wins = 2, peak_rating = 1010 where id = $1`, [A]);
    await db.query(`update profiles set rating = 850, games = 1 where id = $1`, [B]);
    await db.query(`insert into games (game_key, kind, player_a, player_b, winner, reason, rules, moves, a_before, a_delta, b_before, b_delta)
                    values ('lb-1', 'online', $1, $2, 0, 'knockout', '{}', '[]', 880, 20, 870, -20)`, [A, B]);
    await as(B);
    const rating = await call(`leaderboard('rating')`);
    expect(rating.rows.map((r: { username: string }) => r.username).slice(0, 2)).toEqual(['ann', 'bob']);
    expect(rating.me).toMatchObject({ rank: 2, value: 850 });
    const weekly = await call(`leaderboard('weekly')`);
    expect(weekly.rows[0]).toMatchObject({ username: 'ann', value: 20 });
    expect((await call(`leaderboard('streak')`)).rows[0]).toMatchObject({ username: 'cat', value: 1 });
    expect((await call(`leaderboard('puzzles')`)).rows.length).toBeGreaterThanOrEqual(3);
    expect((await call(`leaderboard('friends')`)).rows.map((r: { username: string }) => r.username)).toEqual(['ann', 'bob']);
    await expect(db.query(`select leaderboard('nope')`)).rejects.toThrow(/unknown/);
  });

  it('awards badges from the record', async () => {
    const badges = await call<string[]>(`player_badges($1)`, [A]);
    expect(badges).toEqual(expect.arrayContaining(['first_win', 'online_win', 'rating_1000', 'friend']));
    expect(badges).not.toContain('games_100');
    expect(await call<string[]>(`player_badges($1)`, [C])).toEqual(expect.arrayContaining(['streak_3']));
  });
});

describe('chat', () => {
  it('lets the two players talk, cleaned up and rate-limited', async () => {
    await as(A);
    await call(`find_match('classic', 60)`);
    await as(B);
    const m = (await call(`find_match('classic', 60)`)).match;
    const msg = await call(`send_chat($1, $2)`, [m.id, '  gg   you are SHITTY at this, see www.badsite.com ']);
    expect(msg.body).toBe('gg you are *** at this, see [link]');
    await as(A);
    await call(`send_chat($1, 'good luck!')`, [m.id]);
    expect((await call(`get_chat($1)`, [m.id])).map((c: { body: string }) => c.body)).toEqual(['gg you are *** at this, see [link]', 'good luck!']);
    await as(C);
    await expect(db.query(`select send_chat($1, 'hi')`, [m.id])).rejects.toThrow(/not playing/);
    await expect(db.query(`select get_chat($1)`, [m.id])).rejects.toThrow(/not playing/);
    await as(A);
    for (let i = 0; i < 4; i++) await call(`send_chat($1, 'spam')`, [m.id]);
    await expect(db.query(`select send_chat($1, 'spam')`, [m.id])).rejects.toThrow(/slow down/);
    await expect(db.query(`select send_chat($1, $2)`, [m.id, 'x'.repeat(141)])).rejects.toThrow(/140/);
  });
});

describe('chat filter', () => {
  it('cleans the same way in the browser (friend links) as on the server', async () => {
    const { cleanChat } = await import('../src/game/chat');
    for (const text of ['gg you are SHITTY at this', 'visit www.badsite.com now', 'see example.io/x ok', 'Good game!', 'what the fuck']) {
      const server = await call<string>(`cx_clean($1)`, [text]);
      expect(cleanChat(text)).toBe(server);
    }
  });
});
