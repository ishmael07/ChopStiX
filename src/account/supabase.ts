import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** null until the project is configured; the app then runs in guest-only mode. */
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;
export const accountsEnabled = supabase !== null;

/**
 * Supabase Auth needs an email, so username accounts get an internal address nobody reads.
 * Email confirmation must be off in the Supabase dashboard (Authentication → Sign In / Providers → Email)
 * for these to sign in straight away. Anything containing "@" is taken as a real email (older accounts).
 */
const ACCOUNT_DOMAIN = 'players.chopstix.app';
export const loginEmail = (id: string) => (id.includes('@') ? id.trim() : `${id.trim().toLowerCase()}@${ACCOUNT_DOMAIN}`);

export interface AccountProfile {
  id: string;
  username: string;
  display_name: string;
  skin: number;
  rating: number;
  peak_rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  created_at: string;
  puzzle_rating: number;
  puzzles_attempted: number;
  puzzles_solved: number;
  daily_streak: number;
  best_daily_streak: number;
  last_daily: string | null;
  last_seen: string | null;
}

export interface GameRow {
  id: number;
  game_key: string;
  kind: 'bot' | 'online';
  player_a: string | null;
  player_b: string | null;
  bot_id: string | null;
  winner: 0 | 1 | null;
  reason: string;
  rules: import('../game/rules').Rules;
  moves: unknown[];
  a_before: number | null;
  a_delta: number | null;
  b_before: number | null;
  b_delta: number | null;
  created_at: string;
}

export interface RatedResult {
  status: 'rated' | 'pending' | 'mismatch';
  before?: number;
  delta?: number;
  after?: number;
}
