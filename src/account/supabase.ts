import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** null until the project is configured; the app then runs in guest-only mode. */
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;
export const accountsEnabled = supabase !== null;

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
