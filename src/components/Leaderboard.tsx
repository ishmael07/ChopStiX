import { useEffect, useState } from 'react';
import { Avatar, Seg } from './ui';
import { SKINS } from '../game/profile';
import { leaderboard, type BoardKind, type BoardRow } from '../net/social';

const KINDS: { value: BoardKind; label: string; unit: (v: number) => string; blurb: string; signedIn?: boolean }[] = [
  { value: 'rating', label: 'Rating', unit: (v) => String(v), blurb: 'Highest rated players.' },
  { value: 'weekly', label: 'This week', unit: (v) => (v > 0 ? `+${v}` : String(v)), blurb: 'Most rating gained in the last 7 days.' },
  { value: 'puzzles', label: 'Puzzles', unit: (v) => String(v), blurb: 'Highest puzzle ratings.' },
  { value: 'streak', label: 'Streaks', unit: (v) => `🔥 ${v}`, blurb: 'Longest daily puzzle streaks going right now.' },
  { value: 'friends', label: 'Friends', unit: (v) => String(v), blurb: 'You and your friends, by rating.', signedIn: true },
];

export function Leaderboard({ me, onOpen }: { me: string | null; onOpen: (username: string) => void }) {
  const [kind, setKind] = useState<BoardKind>('rating');
  const [data, setData] = useState<{ rows: BoardRow[]; me: { rank: number; value: number } | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const k = KINDS.find((x) => x.value === kind)!;

  useEffect(() => {
    let on = true;
    setData(null);
    setError(null);
    leaderboard(kind).then((d) => on && setData(d), (e: Error) => on && setError(e.message));
    return () => void (on = false);
  }, [kind]);

  const shownMe = data?.me && !data.rows.some((r) => r.id === me);
  return (
    <div className="screen board-screen">
      <header className="board-head">
        <h1>Leaderboard</h1>
        <p className="muted">{k.blurb}</p>
      </header>
      <div className="board-tabs">
        <Seg value={kind} onChange={setKind} options={KINDS.filter((x) => !x.signedIn || me).map(({ value, label }) => ({ value, label }))} />
      </div>
      <section className="pf-card board-list">
        {error && <div className="notice warn">{error}</div>}
        {!data && !error && <p className="muted">Loading…</p>}
        {data && data.rows.length === 0 && <p className="muted">{kind === 'friends' ? 'Add friends from their profile to see them here.' : 'Nobody here yet. Be the first.'}</p>}
        {data?.rows.map((r) => (
          <button key={r.id} className={`board-row ${r.id === me ? 'me' : ''} ${r.rank <= 3 ? `top top${r.rank}` : ''}`} onClick={() => onOpen(r.username)}>
            <span className="board-rank">{r.rank}</span>
            <span className="board-who">
              <Avatar name={r.display_name} color={SKINS[r.skin] ?? SKINS[1]} size={34} />
              {r.online && <i className="online-dot" title="Online" />}
              <span>
                <b>{r.display_name}</b>
                <small>@{r.username}</small>
              </span>
            </span>
            <span className="board-value">{k.unit(r.value)}</span>
          </button>
        ))}
        {shownMe && (
          <div className="board-row me you-row">
            <span className="board-rank">{data!.me!.rank}</span>
            <span className="board-who">
              <b>You</b>
            </span>
            <span className="board-value">{k.unit(data!.me!.value)}</span>
          </div>
        )}
      </section>
    </div>
  );
}
