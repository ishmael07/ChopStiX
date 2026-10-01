// Local player profile + Elo, persisted in localStorage.
export interface Profile {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  skin: number;
  onboarded?: boolean; // has picked a name on this device
  history: { opp: string; result: 'win' | 'loss' | 'draw'; delta: number; at: number }[];
}

const KEY = 'chopstix.profile';
const fresh = (): Profile => ({ name: 'You', rating: 800, wins: 0, losses: 0, draws: 0, skin: 1, history: [] });

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...fresh(), ...JSON.parse(raw) } : fresh();
  } catch {
    return fresh();
  }
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

export function eloDelta(me: number, opp: number, score: 0 | 0.5 | 1, k = 32) {
  const expected = 1 / (1 + 10 ** ((opp - me) / 400));
  return Math.round(k * (score - expected));
}

export const SKINS = ['#f6d3b3', '#e8b48f', '#c98e64', '#a26b45', '#6f4630'];
