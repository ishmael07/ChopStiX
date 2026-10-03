import { useEffect, useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Avatar, Modal } from '../components/ui';
import { BOTS } from '../game/bots';
import { ratingTitle } from '../game/rating';
import { SKINS } from '../game/profile';
import { supabase, type AccountProfile, type GameRow } from './supabase';
import type { Account } from './useAccount';

interface Row {
  id: number;
  when: string;
  opp: string;
  oppUser?: string;
  result: 'win' | 'loss' | 'draw';
  delta: number;
  after: number;
  reason: string;
  moves: number;
}

export function ProfilePage({ username, account, onOpen }: { username: string; account: Account; onOpen: (u: string) => void }) {
  const [p, setP] = useState<AccountProfile | null | undefined>(undefined);
  const [rows, setRows] = useState<Row[]>([]);
  const [editing, setEditing] = useState(false);
  const mine = account.profile?.username.toLowerCase() === username.toLowerCase();

  useEffect(() => {
    if (!supabase) return;
    let on = true;
    (async () => {
      const { data: prof } = await supabase.from('profiles').select('*').ilike('username', username.replace(/[%_\\]/g, '\\$&')).maybeSingle();
      if (!on) return;
      setP(prof as AccountProfile | null);
      if (!prof) return;
      const { data: games } = await supabase
        .from('games')
        .select('*')
        .or(`player_a.eq.${prof.id},player_b.eq.${prof.id}`)
        .order('created_at', { ascending: false })
        .limit(60);
      const list = (games ?? []) as GameRow[];
      const oppIds = [...new Set(list.map((g) => (g.player_a === prof.id ? g.player_b : g.player_a)).filter(Boolean))] as string[];
      const { data: opps } = oppIds.length ? await supabase.from('profiles').select('id, username, display_name').in('id', oppIds) : { data: [] };
      const names = new Map((opps ?? []).map((o) => [o.id as string, o as { username: string; display_name: string }]));
      if (!on) return;
      setRows(
        list.map((g) => {
          const side = g.player_a === prof.id ? 0 : 1;
          const oppId = side === 0 ? g.player_b : g.player_a;
          const before = (side === 0 ? g.a_before : g.b_before) ?? 0;
          const delta = (side === 0 ? g.a_delta : g.b_delta) ?? 0;
          const opp = g.bot_id ? BOTS.find((b) => b.id === g.bot_id)?.name ?? g.bot_id : names.get(oppId!)?.display_name ?? 'Unknown';
          return {
            id: g.id,
            when: g.created_at,
            opp,
            oppUser: g.bot_id ? undefined : names.get(oppId!)?.username,
            result: g.winner === null ? 'draw' : g.winner === side ? 'win' : 'loss',
            delta,
            after: before + delta,
            reason: g.reason,
            moves: g.moves.length,
          };
        }),
      );
    })();
    return () => {
      on = false;
    };
  }, [username, account.profile?.rating]);

  const history = useMemo(() => [...rows].reverse().map((r) => r.after), [rows]);

  if (p === undefined) return <div className="profile screen" />;
  if (p === null)
    return (
      <div className="profile screen">
        <h1>No player called @{username}</h1>
      </div>
    );

  const total = Math.max(1, p.games);
  return (
    <div className="profile screen">
      <header className="pf-head">
        <Avatar name={p.display_name} color={SKINS[p.skin] ?? SKINS[1]} size={84} />
        <div className="pf-id">
          <h1>{p.display_name}</h1>
          <span className="muted">
            @{p.username} · joined {new Date(p.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
          </span>
        </div>
        {mine && (
          <button className="btn" onClick={() => setEditing(true)}>
            <Pencil size={16} /> Edit
          </button>
        )}
      </header>

      <section className="pf-grid">
        <div className="pf-card rating-card">
          <span className="pf-label">Rating</span>
          <b className="pf-rating">{p.rating}</b>
          <span className="pf-title">
            {ratingTitle(p.rating)}
            {p.games < 20 && <i title="Your rating moves faster for your first 20 games"> · provisional</i>}
          </span>
          <Spark values={history.length ? [800, ...history] : [p.rating, p.rating]} />
          <span className="pf-peak">Peak {p.peak_rating}</span>
        </div>
        <div className="pf-card">
          <span className="pf-label">Record</span>
          <div className="pf-record">
            <div>
              <b>{p.wins}</b>
              <span>Wins</span>
            </div>
            <div>
              <b>{p.losses}</b>
              <span>Losses</span>
            </div>
            <div>
              <b>{p.draws}</b>
              <span>Draws</span>
            </div>
          </div>
          <div className="pf-bar" aria-hidden>
            <i className="w" style={{ width: `${(p.wins / total) * 100}%` }} />
            <i className="d" style={{ width: `${(p.draws / total) * 100}%` }} />
            <i className="l" style={{ width: `${(p.losses / total) * 100}%` }} />
          </div>
          <span className="muted">{p.games ? `${Math.round((p.wins / total) * 100)}% wins over ${p.games} games` : 'No rated games yet'}</span>
        </div>
      </section>

      <section className="pf-card">
        <span className="pf-label">Recent games</span>
        {rows.length === 0 && <p className="muted">Rated games will show up here.</p>}
        <div className="pf-games">
          {rows.slice(0, 20).map((r) => (
            <div className="pf-game" key={r.id}>
              <span className={`res ${r.result}`}>{r.result === 'win' ? 'W' : r.result === 'loss' ? 'L' : 'D'}</span>
              {r.oppUser ? (
                <button className="pf-opp link" onClick={() => onOpen(r.oppUser!)}>
                  {r.opp}
                </button>
              ) : (
                <span className="pf-opp">{r.opp}</span>
              )}
              <span className="muted pf-meta">
                {r.reason} · {r.moves} moves
              </span>
              <span className={`delta ${r.delta >= 0 ? 'up' : 'down'}`}>
                {r.delta >= 0 ? '+' : ''}
                {r.delta}
              </span>
              <span className="muted pf-when">{new Date(r.when).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            </div>
          ))}
        </div>
      </section>

      {editing && account.profile && <EditProfile account={account} onClose={() => setEditing(false)} onSaved={(np) => setP({ ...p, ...np })} />}
    </div>
  );
}

function EditProfile({ account, onClose, onSaved }: { account: Account; onClose: () => void; onSaved: (p: Partial<AccountProfile>) => void }) {
  const [name, setName] = useState(account.profile!.display_name);
  const [skin, setSkin] = useState(account.profile!.skin);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal onClose={onClose}>
      <h2>Edit profile</h2>
      <div className="field">
        <label>Display name</label>
        <input className="text" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Hands</label>
        <div className="skins">
          {SKINS.map((s, i) => (
            <button key={s} className={`skin ${skin === i ? 'on' : ''}`} style={{ background: s }} onClick={() => setSkin(i)} aria-label={`Skin tone ${i + 1}`} />
          ))}
        </div>
      </div>
      {err && <div className="notice warn">{err}</div>}
      <button
        className="btn primary"
        disabled={!name.trim()}
        onClick={async () => {
          const e = await account.update({ display_name: name.trim(), skin });
          if (e) return setErr(e);
          onSaved({ display_name: name.trim(), skin });
          onClose();
        }}
      >
        Save
      </button>
    </Modal>
  );
}

/** Tiny rating-over-time line. */
function Spark({ values }: { values: number[] }) {
  const W = 260, H = 64;
  const min = Math.min(...values) - 10, max = Math.max(...values) + 10;
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * W, H - ((v - min) / (max - min)) * H]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Rating history">
      <path d={`${d} L${W} ${H} L0 ${H} Z`} fill="url(#sg)" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#82c55e" stopOpacity="0.25" />
          <stop offset="1" stopColor="#82c55e" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}
