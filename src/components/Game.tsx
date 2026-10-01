import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, BarChart3, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Crown, Flag, Lightbulb, Pause, Play, Plus, RotateCcw, X } from 'lucide-react';
import { Table, type ViewMode } from './Table';
import { Avatar, Modal } from './ui';
import { applyMove, describeRules, initialState, legalMoves, other, positionKey, winner, type Move, type Rules, type Side, type State } from '../game/rules';
import { evalBar, rankedMoves } from '../game/solver';
import { botMove, type Bot } from '../game/bots';
import { GRADE_META, reviewGame, type Grade } from '../game/review';
import { eloDelta, SKINS, type Profile } from '../game/profile';
import type { NetMsg } from '../net/online';
import { sfx } from '../sound';

export interface Remote {
  send: (m: NetMsg) => void;
  subscribe: (fn: (m: NetMsg) => void) => () => void;
  oppName: string;
  oppRating: number;
  connected: boolean;
}

export interface GameConfig {
  mode: 'bot' | 'local' | 'online';
  rules: Rules;
  clock: number; // seconds per player, 0 = untimed
  mySide: Side; // which side the local player controls (bot/online)
  bot?: Bot;
  remote?: Remote;
}

type Reason = 'knockout' | 'resignation' | 'time' | 'repetition' | 'abandonment';
interface Result {
  winner: Side | null;
  reason: Reason;
}
const REASON_TEXT: Record<Reason, string> = {
  knockout: 'by knockout',
  resignation: 'by resignation',
  time: 'on time',
  repetition: 'by repetition',
  abandonment: 'by abandonment',
};

const darken = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (sh: number) => Math.round(((n >> sh) & 255) * 0.55 + 0x24 * 0.45).toString(16).padStart(2, '0');
  return `#${f(16)}${f(8)}${f(0)}`;
};

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (ms < 10000 && ms > 0) return `0:${(ms / 1000).toFixed(1).padStart(4, '0')}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function Game({
  config,
  profile,
  setProfile,
  onRematch,
  onExit,
}: {
  config: GameConfig;
  profile: Profile;
  setProfile: (p: Profile) => void;
  onRematch: () => void;
  onExit: () => void;
}) {
  const { rules, mode, bot, remote } = config;
  const [states, setStates] = useState<State[]>(() => [initialState()]);
  const [moves, setMoves] = useState<Move[]>([]);
  const [view, setView] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [review, setReview] = useState<{ grades: Grade[]; accuracy: [number, number] } | null>(null);
  const [showEval, setShowEval] = useState(false);
  const [hint, setHint] = useState<Move | null>(null);
  const [clocks, setClocks] = useState<[number, number]>([config.clock * 1000, config.clock * 1000]);
  const [delta, setDelta] = useState<number | null>(null);
  const [rematchAsked, setRematchAsked] = useState({ me: false, them: false });
  const [flipped, setFlipped] = useState(false);
  const [boardView, setViewState] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem('chopstix.view') === '3d' ? '3d' : '2d';
    } catch {
      return '2d';
    }
  });
  const setView3 = (v: ViewMode) => {
    setViewState(v);
    try {
      localStorage.setItem('chopstix.view', v);
    } catch {
      /* ignore */
    }
  };

  const live = states[states.length - 1];
  const viewing = states[view];
  const atLive = view === states.length - 1;
  const bottom: Side = mode === 'local' ? ((flipped ? 1 : 0) as Side) : flipped ? other(config.mySide) : config.mySide;

  const controls = (s: Side) => (mode === 'local' ? true : s === config.mySide);
  const canAct = atLive && !result && controls(live.turn);

  const finished = useRef(false);
  const [revealed, setRevealed] = useState(false);
  const [oldRating] = useState(profile.rating);
  const startedAt = useRef(Date.now());
  const [duration, setDuration] = useState(0);
  const movesRef = useRef<Move[]>([]);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  const finish = useCallback(
    (r: Result) => {
      if (finished.current) return;
      finished.current = true;
      setResult(r);
      setDuration(Date.now() - startedAt.current);
      // Let the final tap land and the fingers settle before announcing anything.
      const settle = r.reason === 'knockout' || r.reason === 'repetition' ? 1250 : 300;
      window.setTimeout(() => {
        const meSide = config.mySide;
        if (mode !== 'local') {
          const score: 0 | 0.5 | 1 = r.winner === null ? 0.5 : r.winner === meSide ? 1 : 0;
          sfx(score === 1 ? 'win' : 'lose');
          const p = profileRef.current;
          const oppRating = mode === 'bot' ? bot!.rating : remote!.oppRating;
          const d = eloDelta(p.rating, oppRating, score);
          setDelta(d);
          setProfile({
            ...p,
            rating: p.rating + d,
            wins: p.wins + (score === 1 ? 1 : 0),
            losses: p.losses + (score === 0 ? 1 : 0),
            draws: p.draws + (score === 0.5 ? 1 : 0),
            history: [
              { opp: mode === 'bot' ? bot!.name : remote!.oppName, result: (score === 1 ? 'win' : score === 0 ? 'loss' : 'draw') as 'win' | 'loss' | 'draw', delta: d, at: Date.now() },
              ...p.history,
            ].slice(0, 30),
          });
        } else sfx('win');
        if (movesRef.current.length) setReview(reviewGame(rules, movesRef.current));
        setRevealed(true);
        window.setTimeout(() => setShowModal(true), 450);
      }, settle);
    },
    [bot, config.mySide, mode, remote, rules, setProfile],
  );

  const play = useCallback(
    (m: Move, fromRemote = false) => {
      if (result) return;
      const s = live;
      if (!legalMoves(rules, s).some((x) => JSON.stringify(x) === JSON.stringify(m))) return;
      const next = applyMove(rules, s, m);
      const newStates = [...states, next];
      setStates(newStates);
      movesRef.current = [...movesRef.current, m];
      setMoves(movesRef.current);
      setView(newStates.length - 1);
      setHint(null);
      if (!fromRemote && mode === 'online') remote!.send({ t: 'move', move: m, ply: moves.length, clockLeft: clocks[s.turn] });
      const w = winner(next);
      if (w !== null) return finish({ winner: w, reason: 'knockout' });
      const key = positionKey(next);
      if (newStates.filter((x) => positionKey(x) === key).length >= 3) finish({ winner: null, reason: 'repetition' });
    },
    [clocks, finish, live, mode, moves.length, remote, result, rules, states],
  );

  // Bot turn.
  useEffect(() => {
    if (mode !== 'bot' || result || live.turn === config.mySide) return;
    const t = window.setTimeout(() => play(botMove(bot!, rules, live)), 650 + Math.random() * 700);
    return () => window.clearTimeout(t);
  }, [bot, config.mySide, live, mode, play, result, rules]);

  // Remote messages.
  const playRef = useRef(play);
  playRef.current = play;
  useEffect(() => {
    if (!remote) return;
    return remote.subscribe((msg) => {
      if (msg.t === 'move') {
        playRef.current(msg.move, true);
        if (config.clock) setClocks((c) => (config.mySide === 0 ? [c[0], msg.clockLeft] : [msg.clockLeft, c[1]]));
      }
      if (msg.t === 'resign') finish({ winner: config.mySide, reason: 'resignation' });
      if (msg.t === 'rematch') setRematchAsked((r) => ({ ...r, them: true }));
    });
  }, [config.clock, config.mySide, finish, remote]);

  useEffect(() => {
    if (remote && !remote.connected && !result && moves.length > 0) finish({ winner: config.mySide, reason: 'abandonment' });
  }, [config.mySide, finish, moves.length, remote, result]);

  useEffect(() => {
    if (rematchAsked.me && rematchAsked.them) onRematch();
  }, [onRematch, rematchAsked]);

  // Clocks start after each side's first move, like chess.com.
  useEffect(() => {
    if (!config.clock || result || moves.length < 2) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setClocks((c) => {
        const n: [number, number] = [...c];
        n[live.turn] = Math.max(0, n[live.turn] - dt);
        return n;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [config.clock, live.turn, moves.length, result]);

  useEffect(() => {
    if (!config.clock || result) return;
    const flagged = clocks.findIndex((c) => c <= 0);
    if (flagged >= 0 && (mode !== 'online' || flagged === config.mySide)) {
      finish({ winner: other(flagged as Side), reason: 'time' });
      if (mode === 'online') remote!.send({ t: 'resign' });
    }
  }, [clocks, config.clock, config.mySide, finish, mode, remote, result]);

  // Arrow keys walk through history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setView((v) => Math.max(0, v - 1));
      if (e.key === 'ArrowRight') setView((v) => Math.min(states.length - 1, v + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [states.length]);

  const resign = () => {
    if (result) return;
    const loser = mode === 'local' ? live.turn : config.mySide;
    if (mode === 'online') remote!.send({ t: 'resign' });
    finish({ winner: other(loser), reason: 'resignation' });
  };

  const rematch = () => {
    if (mode !== 'online') return onRematch();
    remote!.send({ t: 'rematch' });
    setRematchAsked((r) => ({ ...r, me: true }));
  };

  const runReview = () => {
    setShowModal(false);
    setShowEval(true);
    setView(0);
    setReplaying(true);
  };

  // Replay: step through the game one move at a time.
  const [replaying, setReplaying] = useState(false);
  useEffect(() => {
    if (!replaying) return;
    const id = window.setInterval(() => {
      setView((v) => {
        if (v >= states.length - 1) {
          setReplaying(false);
          return v;
        }
        return v + 1;
      });
    }, 1100);
    return () => window.clearInterval(id);
  }, [replaying, states.length]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.mv.cur')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [view]);

  const ev = useMemo(() => evalBar(rules, viewing), [rules, viewing]);

  const names: [string, string] =
    mode === 'local'
      ? ['Player 1', 'Player 2']
      : mode === 'bot'
        ? config.mySide === 0
          ? [profile.name, bot!.name]
          : [bot!.name, profile.name]
        : config.mySide === 0
          ? [profile.name, remote!.oppName]
          : [remote!.oppName, profile.name];
  const oppSkin = SKINS[(profile.skin + 2) % SKINS.length];
  const skins: [string, string] =
    mode === 'local' ? [SKINS[profile.skin], oppSkin] : config.mySide === 0 ? [SKINS[profile.skin], oppSkin] : [oppSkin, SKINS[profile.skin]];
  const MY_SLEEVE = '#ecebe6';
  const oppSleeve = mode === 'bot' ? darken(bot!.color) : '#2a2826';
  const sleeves: [string, string] = mode === 'local' || config.mySide === 0 ? [MY_SLEEVE, oppSleeve] : [oppSleeve, MY_SLEEVE];

  const isBotSide = (s: Side) => mode === 'bot' && s !== config.mySide;
  const ratingOf = (s: Side) => (mode === 'local' ? null : isBotSide(s) ? bot!.rating : s === config.mySide ? profile.rating : remote!.oppRating);
  const colorOf = (s: Side) => (isBotSide(s) ? bot!.color : skins[s]);

  const playerBar = (side: Side) => {
    const rating = ratingOf(side);
    const active = !result && live.turn === side;
    return (
      <div className={`player-bar ${active ? 'active' : ''}`}>
        <Avatar name={names[side]} color={colorOf(side)} size={38} />
        <div className="pname">
          <b>{names[side]}</b>
          {rating !== null && <span className="rating">{rating}</span>}
          {active && <span className="turn-dot" title="To move" />}
          {revealed && result?.winner === side && <Crown size={16} className="crown" />}
        </div>
        {config.clock > 0 && <div className={`clock ${active ? 'running' : ''} ${clocks[side] < 10000 ? 'low' : ''}`}>{fmt(clocks[side])}</div>}
      </div>
    );
  };

  const rows = [];
  for (let i = 0; i < moves.length; i += 2) rows.push(i);
  const cell = (i: number) =>
    i < moves.length ? (
      <button className={`mv ${view === i + 1 ? 'cur' : ''}`} onClick={() => (setReplaying(false), setView(i + 1))}>
        {review && revealed && (
          <span className="grade" style={{ background: GRADE_META[review.grades[i]].color }} title={GRADE_META[review.grades[i]].label}>
            {GRADE_META[review.grades[i]].icon}
          </span>
        )}
        {moveText(moves[i])}
      </button>
    ) : (
      <span />
    );

  const meWon = result && result.winner !== null && (mode === 'local' || result.winner === config.mySide);
  const title = !result ? '' : result.winner === null ? 'Draw' : mode === 'local' ? `${names[result.winner]} wins` : meWon ? 'You won' : 'You lost';
  const timeLabel = config.clock ? (config.clock >= 60 ? `${config.clock / 60} min` : `${config.clock}s`) : null;
  const status = result ? null : canAct ? (mode === 'local' ? `${names[live.turn]} to move` : 'Your move') : mode === 'bot' ? `${bot!.name} is thinking…` : `${names[live.turn]} to move`;
  const mins = Math.floor(duration / 60000);
  const secs = Math.round((duration % 60000) / 1000);

  return (
    <div className="game screen">
      <div className="board-col">
        {playerBar(other(bottom))}
        <div className="board-wrap">
          {showEval && (
            <div className="evalbar" title="Solver evaluation">
              <div className="eval-fill" style={{ height: `${50 + ev.value * 50}%` }} />
            </div>
          )}
          <Table
            state={viewing}
            rules={rules}
            bottom={bottom}
            canAct={canAct}
            lastMove={view > 0 ? moves[view - 1] : null}
            ply={view}
            skins={skins}
            sleeves={sleeves}
            view={boardView}
            onView={setView3}
            hint={atLive ? hint : null}
            onMove={(m) => play(m)}
          />
        </div>
        {playerBar(bottom)}
      </div>

      <aside className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">{mode === 'bot' ? `vs ${bot!.name}` : mode === 'local' ? 'Local game' : `vs ${remote!.oppName}`}</div>
            <div className="chips">
              <span className="chip">{describeRules(rules)}</span>
              {timeLabel && <span className="chip">{timeLabel}</span>}
            </div>
          </div>
          <button className="icon-btn" onClick={onExit} title="Leave game" aria-label="Leave game">
            <X size={18} />
          </button>
        </div>

        {!revealed && status && <div className={`status ${canAct ? 'go' : ''}`}>{status}</div>}

        {revealed && result && (
          <div className="post">
            <div className={`post-banner ${meWon ? 'won' : result.winner === null ? 'drew' : 'lost'}`}>
              <div>
                <b>{title}</b>
                <span>
                  {REASON_TEXT[result.reason]} · {moves.length} moves · {mins}:{String(secs).padStart(2, '0')}
                </span>
              </div>
              {delta !== null && (
                <span className={`delta ${delta >= 0 ? 'up' : 'down'}`}>
                  {delta >= 0 ? '+' : ''}
                  {delta}
                </span>
              )}
            </div>
            {review && (
              <div className="post-acc">
                {([0, 1] as Side[]).map((sd) => (
                  <div className="acc" key={sd}>
                    <span>
                      <i className="dot" style={{ background: colorOf(sd) }} />
                      {names[sd]}
                    </span>
                    <b>{review.accuracy[sd]}%</b>
                    <small>accuracy</small>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="moves-head">
          <span />
          {([0, 1] as Side[]).map((sd) => (
            <span key={sd}>
              <i className="dot" style={{ background: colorOf(sd) }} />
              {names[sd]}
            </span>
          ))}
        </div>
        <div className="movelist" ref={listRef}>
          {rows.length === 0 && <div className="empty">Pick one of your hands, then tap a hand to add your fingers to it.</div>}
          {rows.map((i) => (
            <div className="mv-row" key={i}>
              <span className="mv-num">{i / 2 + 1}</span>
              {cell(i)}
              {cell(i + 1)}
            </div>
          ))}
        </div>

        <div className="nav-row">
          <button onClick={() => (setReplaying(false), setView(0))} aria-label="First move">
            <ChevronsLeft size={18} />
          </button>
          <button onClick={() => (setReplaying(false), setView((v) => Math.max(0, v - 1)))} aria-label="Previous move">
            <ChevronLeft size={18} />
          </button>
          {revealed && (
            <button className={replaying ? 'on' : ''} onClick={() => (view >= states.length - 1 && setView(0), setReplaying((r) => !r))} aria-label={replaying ? 'Pause replay' : 'Replay game'}>
              {replaying ? <Pause size={17} /> : <Play size={17} />}
            </button>
          )}
          <button onClick={() => (setReplaying(false), setView((v) => Math.min(states.length - 1, v + 1)))} aria-label="Next move">
            <ChevronRight size={18} />
          </button>
          <button onClick={() => (setReplaying(false), setView(states.length - 1))} aria-label="Latest move">
            <ChevronsRight size={18} />
          </button>
        </div>

        <div className="actions" key={revealed ? 'post' : 'live'}>
          {!revealed ? (
            <>
              {mode !== 'online' && (
                <button className="tool" disabled={!canAct} onClick={() => setHint(rankedMoves(rules, live)[0].move)}>
                  <Lightbulb size={18} />
                  <span>Hint</span>
                </button>
              )}
              <button className="tool" onClick={() => setFlipped((f) => !f)}>
                <ArrowUpDown size={18} />
                <span>Switch seat</span>
              </button>
              <button className={`tool ${showEval ? 'on' : ''}`} onClick={() => setShowEval((s) => !s)}>
                <BarChart3 size={18} />
                <span>Eval</span>
              </button>
              <button className="tool danger" onClick={resign} disabled={!!result}>
                <Flag size={18} />
                <span>Resign</span>
              </button>
            </>
          ) : (
            <div className="end-actions">
              <button className="btn primary" onClick={rematch} disabled={rematchAsked.me}>
                <RotateCcw size={17} /> {rematchAsked.me ? 'Waiting…' : rematchAsked.them ? 'Accept rematch' : 'Rematch'}
              </button>
              <button className="btn" onClick={onExit}>
                <Plus size={17} /> New game
              </button>
            </div>
          )}
        </div>
        {rematchAsked.them && !rematchAsked.me && <div className="notice">{remote?.oppName} wants a rematch</div>}
        {remote && !remote.connected && <div className="notice warn">Opponent disconnected</div>}
      </aside>

      {result && revealed && showModal && (
        <Modal onClose={() => setShowModal(false)} className="result">
          <div className="result-title">
            <h2 className={meWon ? 'won' : result.winner === null ? 'drew' : 'lost'}>{title}</h2>
            <p>{REASON_TEXT[result.reason]}</p>
          </div>
          <div className="versus">
            {([config.mode === 'local' ? 0 : config.mySide, config.mode === 'local' ? 1 : other(config.mySide)] as Side[]).map((sd, k) => (
              <div key={sd} className={`vs-player ${result.winner === sd ? 'w' : ''} ${result.winner !== null && result.winner !== sd ? 'l' : ''}`} style={{ animationDelay: `${120 + k * 80}ms` }}>
                <div className="vs-avatar">
                  <Avatar name={names[sd]} color={colorOf(sd)} size={64} />
                  {result.winner === sd && <Crown size={20} className="crown" />}
                </div>
                <b>{names[sd]}</b>
                <span>{sd === config.mySide && delta !== null ? oldRating : ratingOf(sd) ?? ''}</span>
              </div>
            ))}
            <div className="vs-score">
              {result.winner === null ? '½ – ½' : `${result.winner === (config.mode === 'local' ? 0 : config.mySide) ? 1 : 0} – ${result.winner === (config.mode === 'local' ? 0 : config.mySide) ? 0 : 1}`}
            </div>
          </div>
          {delta !== null && (
            <div className="rating-line">
              <span>Rating</span>
              <b>
                <CountUp from={oldRating} to={oldRating + delta} />
              </b>
              <span className={`delta ${delta >= 0 ? 'up' : 'down'}`}>
                {delta >= 0 ? '+' : ''}
                {delta}
              </span>
            </div>
          )}
          <div className="result-actions">
            <button className="btn primary" onClick={() => (setShowModal(false), rematch())} disabled={rematchAsked.me}>
              <RotateCcw size={17} /> Rematch
            </button>
            <div className="row2">
              <button className="btn" onClick={runReview}>
                <Play size={16} /> Replay
              </button>
              <button className="btn" onClick={onExit}>
                <Plus size={17} /> New game
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const H = ['L', 'R'];
function moveText(m: Move) {
  if (m.kind === 'attack') return `${H[m.from]} → ${H[m.to]}`;
  if (m.kind === 'self') return `${H[m.from]} → own ${H[1 - m.from]}`;
  return `Split ${m.to[0]}·${m.to[1]}`;
}

function CountUp({ from, to }: { from: number; to: number }) {
  const [v, setV] = useState(from);
  useEffect(() => {
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / 900);
      setV(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    const start = window.setTimeout(() => (raf = requestAnimationFrame(tick)), 350);
    return () => (window.clearTimeout(start), cancelAnimationFrame(raf));
  }, [from, to]);
  return <>{v}</>;
}
