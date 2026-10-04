import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Crown, Pause, Play } from 'lucide-react';
import { Table, type ViewMode } from '../components/Table';
import { Avatar } from '../components/ui';
import { BOTS } from '../game/bots';
import { SKINS } from '../game/profile';
import { GRADE_META, reviewGame } from '../game/review';
import { moveText } from '../components/Game';
import { applyMove, describeRules, initialState, type Move, type Rules, type Side, type State } from '../game/rules';
import { supabase, type GameRow } from './supabase';

interface Seat {
  name: string;
  username?: string;
  rating: number | null;
  delta: number | null;
  color: string;
}

/** A finished rated game, step by step. Lives at #/game/<id> so it can be shared. */
export function GameViewer({ id, view, onView, onOpen }: { id: number; view: ViewMode; onView: (v: ViewMode) => void; onOpen: (username: string) => void }) {
  const [game, setGame] = useState<GameRow | null | undefined>(supabase ? undefined : null);
  const [seats, setSeats] = useState<[Seat, Seat] | null>(null);
  const [ply, setPly] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let on = true;
    (async () => {
      const { data: g } = await supabase.from('games').select('*').eq('id', id).maybeSingle();
      if (!on) return;
      if (!g) return setGame(null);
      const row = g as GameRow;
      const ids = [row.player_a, row.player_b].filter(Boolean) as string[];
      const { data: ps } = ids.length ? await supabase.from('profiles').select('id, username, display_name, skin').in('id', ids) : { data: [] };
      if (!on) return;
      const byId = new Map((ps ?? []).map((p) => [p.id as string, p as { username: string; display_name: string; skin: number }]));
      const bot = BOTS.find((b) => b.id === row.bot_id);
      const seat = (uid: string | null, before: number | null, delta: number | null): Seat => {
        if (!uid && bot) return { name: bot.name, rating: bot.rating, delta: null, color: bot.color };
        const p = uid ? byId.get(uid) : undefined;
        return { name: p?.display_name ?? 'Deleted player', username: p?.username, rating: before, delta, color: SKINS[p?.skin ?? 1] ?? SKINS[1] };
      };
      setSeats([seat(row.player_a, row.a_before, row.a_delta), seat(row.player_b, row.b_before, row.b_delta)]);
      setGame(row);
      setPly(row.moves.length);
    })();
    return () => void (on = false);
  }, [id]);

  const moves = useMemo(() => (game?.moves ?? []) as Move[], [game]);
  const rules = game?.rules as Rules | undefined;
  const states = useMemo(() => (rules ? moves.reduce<State[]>((acc, m) => [...acc, applyMove(rules, acc[acc.length - 1], m)], [initialState()]) : [initialState()]), [moves, rules]);
  const review = useMemo(() => (rules && moves.length ? reviewGame(rules, moves) : null), [moves, rules]);

  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => setPly((p) => (p >= moves.length ? (setPlaying(false), p) : p + 1)), 1000);
    return () => window.clearInterval(t);
  }, [moves.length, playing]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setPly((p) => Math.max(0, p - 1));
      if (e.key === 'ArrowRight') setPly((p) => Math.min(moves.length, p + 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [moves.length]);

  if (game === undefined) return <div className="screen" />;
  if (game === null || !seats || !rules)
    return (
      <div className="profile screen">
        <h1>That game doesn't exist.</h1>
      </div>
    );

  const bar = (s: Side) => {
    const p = seats[s];
    return (
      <div className="player-bar">
        <Avatar name={p.name} color={p.color} size={38} />
        <div className="pname">
          {p.username ? (
            <button className="link-name" onClick={() => onOpen(p.username!)}>
              {p.name}
            </button>
          ) : (
            <b>{p.name}</b>
          )}
          {p.rating !== null && <span className="rating">{p.rating}</span>}
          {p.delta !== null && <span className={`delta ${p.delta >= 0 ? 'up' : 'down'}`}>{p.delta >= 0 ? `+${p.delta}` : p.delta}</span>}
          {game.winner === s && <Crown size={16} className="crown" />}
        </div>
      </div>
    );
  };
  const result = game.winner === null ? 'Draw' : `${seats[game.winner].name} won`;
  const rows: number[] = [];
  for (let i = 0; i < moves.length; i += 2) rows.push(i);
  const cell = (i: number) =>
    i < moves.length ? (
      <button className={`mv ${ply === i + 1 ? 'cur' : ''}`} onClick={() => (setPlaying(false), setPly(i + 1))}>
        {review && (
          <span className="grade" style={{ background: GRADE_META[review.grades[i]].color }} title={GRADE_META[review.grades[i]].label}>
            {GRADE_META[review.grades[i]].icon}
          </span>
        )}
        {moveText(moves[i])}
      </button>
    ) : (
      <span />
    );

  return (
    <div className="game screen">
      <div className="board-col">
        {bar(1)}
        <div className="board-wrap">
          <Table
            state={states[ply]}
            rules={rules}
            bottom={0}
            canAct={false}
            lastMove={ply > 0 ? moves[ply - 1] : null}
            ply={ply}
            skins={[seats[0].color, seats[1].color]}
            sleeves={['#ecebe6', '#2a2826']}
            view={view}
            onView={onView}
            onMove={() => {}}
          />
        </div>
        {bar(0)}
      </div>
      <aside className="panel">
        <div className="panel-top">
          <span className="chip">{describeRules(rules)}</span>
          <span className="chip">{game.kind === 'bot' ? 'vs computer' : 'online'}</span>
        </div>
        <div className="post">
        <div className={`post-banner ${game.winner === null ? 'drew' : 'won'}`}>
          <div>
            <b>{result}</b>
            <span>
              by {game.reason} · {moves.length} moves · {new Date(game.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
        </div>
        {review && (
          <div className="post-acc">
            {([0, 1] as Side[]).map((sd) => (
              <div className="acc" key={sd}>
                <span>
                  <i className="dot" style={{ background: seats[sd].color }} />
                  {seats[sd].name}
                </span>
                <b>{review.accuracy[sd]}%</b>
                <small>accuracy</small>
              </div>
            ))}
          </div>
        )}
        </div>
        <div className="movelist">
          {rows.length === 0 && <div className="empty">No moves were played.</div>}
          {rows.map((i) => (
            <div className="mv-row" key={i}>
              <span className="mv-num">{i / 2 + 1}</span>
              {cell(i)}
              {cell(i + 1)}
            </div>
          ))}
        </div>
        <div className="nav-row">
          <button onClick={() => (setPlaying(false), setPly(0))} aria-label="First move">
            <ChevronsLeft size={18} />
          </button>
          <button onClick={() => (setPlaying(false), setPly((p) => Math.max(0, p - 1)))} aria-label="Previous move">
            <ChevronLeft size={18} />
          </button>
          <button className={playing ? 'on' : ''} onClick={() => (ply >= moves.length && setPly(0), setPlaying((p) => !p))} aria-label={playing ? 'Pause replay' : 'Replay game'}>
            {playing ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <button onClick={() => (setPlaying(false), setPly((p) => Math.min(moves.length, p + 1)))} aria-label="Next move">
            <ChevronRight size={18} />
          </button>
          <button onClick={() => (setPlaying(false), setPly(moves.length))} aria-label="Latest move">
            <ChevronsRight size={18} />
          </button>
        </div>
      </aside>
    </div>
  );
}
