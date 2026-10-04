// Puzzles, leaderboards, friends, challenges, badges and chat (supabase/migrations/0003_daily.sql).
import type { Hands, Rules } from '../game/rules';
import { supabase } from '../account/supabase';
import type { MatchRow, QuickMode } from './match';

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase!.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export interface PlayerCard {
  id: string;
  username: string;
  display_name: string;
  skin: number;
  rating: number;
}

// ---------- puzzles
export interface Puzzle {
  id: number;
  mode: string;
  rules: Rules;
  hands: [Hands, Hands]; // yours first; you move first
  moves: number; // win in this many of your moves
  rating: number;
  solves: number;
  attempts: number;
}
export interface Daily {
  day: string;
  puzzle: Puzzle;
  solved_today: boolean;
  streak: number;
  best_streak: number;
}
export interface PuzzleResult {
  solved: boolean;
  status: 'rated' | 'practice' | 'guest';
  delta?: number;
  puzzle_rating?: number;
  daily?: boolean;
  streak?: number;
  best_streak?: number;
}
export const dailyPuzzle = () => rpc<Daily>('daily_puzzle');
export const nextPuzzle = (skip?: number) => rpc<Puzzle>('next_puzzle', { p_skip: skip ?? null });
export const submitPuzzle = (id: number, moves: unknown[]) => rpc<PuzzleResult>('submit_puzzle', { p_puzzle: id, p_moves: moves });

// ---------- leaderboards
export type BoardKind = 'rating' | 'weekly' | 'puzzles' | 'streak' | 'friends';
export interface BoardRow {
  rank: number;
  value: number;
  id: string;
  username: string;
  display_name: string;
  skin: number;
  online: boolean;
}
export const leaderboard = (kind: BoardKind) => rpc<{ rows: BoardRow[]; me: { rank: number; value: number } | null }>('leaderboard', { p_kind: kind });

// ---------- friends and challenges
export interface Friend extends PlayerCard {
  online: boolean;
  status: 'friends' | 'incoming' | 'outgoing';
}
export const friendsList = () => rpc<Friend[]>('friends_list');
export const friendRequest = (id: string) => rpc<'friends' | 'outgoing'>('friend_request', { p_user: id });
export const friendRemove = (id: string) => rpc<void>('friend_remove', { p_user: id });
export const challengeFriend = (id: string, mode: QuickMode, clock: number) => rpc<string>('challenge_friend', { p_user: id, p_mode: mode, p_clock: clock });
export const cancelChallenge = (id: string) => rpc<void>('cancel_challenge', { p_id: id });
export const respondChallenge = (id: string, accept: boolean) => rpc<MatchRow | null>('respond_challenge', { p_id: id, p_accept: accept });

export interface Challenge {
  id: string;
  mode: QuickMode;
  clock: number;
  from: PlayerCard;
}
export interface Heartbeat {
  challenges: Challenge[];
  sent: { id: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired'; to: string; match: MatchRow | null } | null;
  friend_requests: number;
}
export const heartbeat = () => rpc<Heartbeat | null>('heartbeat');

export const playerBadges = (id: string) => rpc<string[]>('player_badges', { p_user: id });

// ---------- chat in server-run games
export interface ChatRow {
  id: number;
  match_id: string;
  sender: string;
  body: string;
  created_at: string;
}
export const sendChat = (match: string, body: string) => rpc<ChatRow>('send_chat', { p_match: match, p_body: body });
export const getChat = (match: string) => rpc<ChatRow[]>('get_chat', { p_match: match });

/** New messages for a game as they arrive (realtime, with a slow poll behind it). */
export function watchChat(match: string, onRows: (rows: ChatRow[]) => void) {
  const channel = supabase!
    .channel(`chat-${match}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'match_chat', filter: `match_id=eq.${match}` }, (p) => onRows([p.new as ChatRow]))
    .subscribe((status) => status === 'SUBSCRIBED' && void getChat(match).then(onRows, () => {}));
  const poll = window.setInterval(() => void getChat(match).then(onRows, () => {}), 5000);
  return () => {
    window.clearInterval(poll);
    void supabase!.removeChannel(channel);
  };
}
