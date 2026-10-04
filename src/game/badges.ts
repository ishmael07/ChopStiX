// Badge names and blurbs. Who has which is worked out by the database (player_badges in 0003_daily.sql).
export interface Badge {
  id: string;
  icon: string;
  name: string;
  blurb: string;
}

export const BADGES: Badge[] = [
  { id: 'first_win', icon: '🏁', name: 'First win', blurb: 'Win a rated game' },
  { id: 'online_win', icon: '🌍', name: 'World stage', blurb: 'Beat someone online' },
  { id: 'beat_kenji', icon: '🥋', name: 'Black belt', blurb: 'Beat Kenji' },
  { id: 'held_sensei', icon: '🥢', name: 'Held the master', blurb: 'Draw or beat Sensei' },
  { id: 'win_streak_5', icon: '🔥', name: 'On fire', blurb: 'Win 5 games in a row' },
  { id: 'games_10', icon: '✋', name: 'Regular', blurb: 'Play 10 rated games' },
  { id: 'games_100', icon: '💯', name: 'Centurion', blurb: 'Play 100 rated games' },
  { id: 'rating_1000', icon: '🥉', name: 'Intermediate', blurb: 'Reach a 1000 rating' },
  { id: 'rating_1400', icon: '🥈', name: 'Advanced', blurb: 'Reach a 1400 rating' },
  { id: 'rating_1800', icon: '🥇', name: 'Expert', blurb: 'Reach an 1800 rating' },
  { id: 'puzzles_10', icon: '🧩', name: 'Puzzler', blurb: 'Solve 10 puzzles' },
  { id: 'puzzles_50', icon: '🧠', name: 'Puzzle master', blurb: 'Solve 50 puzzles' },
  { id: 'streak_3', icon: '📅', name: 'Habit', blurb: '3-day daily puzzle streak' },
  { id: 'streak_7', icon: '⚡', name: 'Week strong', blurb: '7-day daily puzzle streak' },
  { id: 'streak_30', icon: '🏆', name: 'Unstoppable', blurb: '30-day daily puzzle streak' },
  { id: 'friend', icon: '🤝', name: 'Friendly', blurb: 'Make a friend' },
];
