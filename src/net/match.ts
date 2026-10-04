// Quick play against strangers. The database runs these games (see supabase/migrations/0002_quick_play.sql):
// we send moves with RPCs and hear about the other side's through Supabase Realtime.
import type { Move, Rules, Side } from '../game/rules';
import { supabase } from '../account/supabase';

export type QuickMode = 'classic' | 'street';
export const QUICK_CLOCKS = [30, 60, 180] as const;

export interface MatchPlayer {
  id: string;
  username: string;
  display_name: string;
  skin: number;
  rating: number;
}

export interface MatchRow {
  id: string;
  player_a: string;
  player_b: string;
  rules: Rules;
  clock: number;
  moves: Move[];
  clock_a_ms: number;
  clock_b_ms: number;
  status: 'active' | 'finished' | 'aborted';
  winner: Side | null;
  reason: 'knockout' | 'resignation' | 'time' | 'repetition' | 'aborted' | null;
  a_before: number | null;
  a_delta: number | null;
  b_before: number | null;
  b_delta: number | null;
  rematch_a: boolean;
  rematch_b: boolean;
  next_match: string | null;
  /** How long the side to move had been thinking when the server sent this. Absent on realtime updates (≈ 0). */
  elapsed_ms?: number;
  players?: [MatchPlayer, MatchPlayer];
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase!.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const findMatch = (mode: QuickMode, clock: number) =>
  rpc<{ status: 'queued'; waited: number } | { status: 'matched'; match: MatchRow }>('find_match', { p_mode: mode, p_clock: clock });
export const leaveQueue = () => rpc<void>('leave_queue');
export const currentMatch = () => rpc<MatchRow | null>('current_match');
export const getMatch = (id: string) => rpc<MatchRow>('get_match', { p_match: id });

export interface MatchLink {
  id: string;
  mySide: Side;
  opp: MatchPlayer;
  initial: MatchRow;
  /** Every new version of the game, from our own calls, realtime, or the backup poll. */
  subscribe: (fn: (row: MatchRow) => void) => () => void;
  /** Resolves false if the server refused the move; `latest()` then has the real game. */
  move: (ply: number, m: Move) => Promise<boolean>;
  latest: () => MatchRow;
  resign: () => void;
  claimTimeout: () => void;
  rematch: () => void;
  close: () => void;
}

export function openMatch(row: MatchRow, me: string): MatchLink {
  const mySide: Side = row.player_a === me ? 0 : 1;
  const players = row.players!;
  const listeners = new Set<(r: MatchRow) => void>();
  let latest = row;
  // Rows can arrive out of order (realtime vs. RPC replies), so only ever move forward.
  const rank = (r: MatchRow) => r.moves.length * 4 + (r.status === 'active' ? 0 : 2) + (r.next_match ? 1 : 0) + (r.rematch_a ? 0.25 : 0) + (r.rematch_b ? 0.25 : 0);
  const push = (r: MatchRow | null | undefined) => {
    if (!r || r.id !== row.id || rank(r) < rank(latest)) return;
    latest = { ...r, players };
    listeners.forEach((fn) => fn(latest));
  };
  /** Resolves false if the server refused, after fetching the game as the server has it. */
  const call = (fn: string, args: Record<string, unknown> = {}) =>
    rpc<MatchRow>(fn, { p_match: row.id, ...args }).then(
      (r) => (push(r), true),
      () => getMatch(row.id).then(push, () => {}).then(() => false),
    );

  const channel = supabase!
    .channel(`match-${row.id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${row.id}` }, (p) => push({ ...(p.new as MatchRow), elapsed_ms: 0 }))
    .subscribe((status) => status === 'SUBSCRIBED' && void getMatch(row.id).then(push, () => {}));
  // Backup in case realtime drops a message.
  const poll = window.setInterval(() => void getMatch(row.id).then(push, () => {}), 4000);

  return {
    id: row.id,
    mySide,
    opp: players[mySide === 0 ? 1 : 0],
    initial: row,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    move: (ply, m) => call('play_move', { p_ply: ply, p_move: m }),
    latest: () => latest,
    resign: () => void call('resign_match'),
    claimTimeout: () => void call('claim_timeout'),
    rematch: () => void call('request_rematch'),
    close: () => {
      window.clearInterval(poll);
      void supabase!.removeChannel(channel);
    },
  };
}
