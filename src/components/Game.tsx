import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, BarChart3, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Crown, Flag, Lightbulb, Pause, Play, Plus, RotateCcw, X } from 'lucide-react';
import { Table, type ViewMode } from './Table';
import { Avatar, clockLabel, Modal } from './ui';
import { applyMove, describeRules, initialState, legalMoves, other, positionKey, winner, type Move, type Rules, type Side, type State } from '../game/rules';
import { evalBar, rankedMoves } from '../game/solver';
import { botMove, type Bot } from '../game/bots';
import { GRADE_META, reviewGame, type Grade } from '../game/review';
import { SKINS, type Profile } from '../game/profile';
import { ratingChange } from '../game/rating';
import { supabase, type RatedResult } from '../account/supabase';
import type { NetMsg } from '../net/online';
import type { MatchLink, MatchRow } from '../net/match';
import { sendChat, watchChat, type ChatRow } from '../net/social';
import { cleanChat } from '../game/chat';
import { Chat, type ChatLine } from './Chat';
import { sfx } from '../sound';

export interface Remote {
  send: (m: NetMsg) => void;
  subscribe: (fn: (m: NetMsg) => void) => () => void;
  oppName: string;
  oppRating: number;
  oppUid?: string; // set when the friend is signed in
  connected: boolean;
}

export interface GameConfig {
  mode: 'bot' | 'local' | 'online' | 'quick'; // online = friend link, quick = matched stranger (server-run)
  rules: Rules;
  clock: number; // seconds per player, 0 = untimed
  mySide: Side; // which side the local player controls (bot/online)
  bot?: Bot;
  remote?: Remote;
  match?: MatchLink;
  /** Signed-in player: games are rated on the server instead of locally. */
  account?: { onRated: () => void };
  /** Shared id for a friend game, the same on both screens. */
  gameKey?: string;
}

type Reason = 'knockout' | 'resignation' | 'time' | 'repetition' | 'abandonment' | 'aborted';
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
  aborted: 'before both players moved',
};

const statesFrom = (rules: Rules, moves: Move[]) => moves.reduce<State[]>((acc, m) => [...acc, applyMove(rules, acc[acc.length - 1], m)], [initialState()]);
/** Clocks as of now: the side to move has been thinking for elapsed_ms (clocks start after each side's first move). */
const clocksOf = (r: MatchRow): [number, number] => {
  const running = r.status === 'active' && r.moves.length >= 2 ? r.moves.length % 2 : -1;
  const el = r.elapsed_ms ?? 0;
  return [r.clock_a_ms - (running === 0 ? el : 0), r.clock_b_ms - (running === 1 ? el : 0)];
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
  chatOn = true,
}: {
  chatOn?: boolean;
  config: GameConfig;
  profile: Profile;
  setProfile: (p: Profile) => void;
  onRematch: () => void;
  onExit: () => void;
}) {
  const { rules, mode, bot, remote, match } = config;
  const quick = mode === 'quick';
  const net = mode === 'online' || quick;
  const [states, setStates] = useState<State[]>(() => statesFrom(rules, match?.initial.moves ?? []));
  const [moves, setMoves] = useState<Move[]>(() => match?.initial.moves ?? []);
  const [view, setView] = useState(() => match?.initial.moves.length ?? 0);
  const [result, setResult] = useState<Result | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [review, setReview] = useState<{ grades: Grade[]; accuracy: [number, number] } | null>(null);
  const [showEval, setShowEval] = useState(false);
  const [hint, setHint] = useState<Move | null>(null);
  const [clocks, setClocks] = useState<[number, number]>(() => (match ? clocksOf(match.initial) : [config.clock * 1000, config.clock * 1000]));
  const [delta, setDelta] = useState<number | null>(null);
  const [rematchAsked, setRematchAsked] = useState({ me: false, them: false });
  const [flipped, setFlipped] = useState(false);
  // Focus mode: board fills the screen (native fullscreen where supported).
  const [focus, setFocus] = useState(false);
  const toggleFocus = () => {
    const next = !focus;
    setFocus(next);
    try {
      if (next && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
      if (!next && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    } catch {
      /* fullscreen not available: the CSS layout still enlarges the board */
    }
  };
  useEffect(() => {
    const onFs = () => !document.fullscreenElement && setFocus(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFocus(false);
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('keydown', onKey);
    return () => (document.removeEventListener('fullscreenchange', onFs), window.removeEventListener('keydown', onKey));
  }, []);
  useEffect(() => () => void (document.fullscreenElement && document.exitFullscreen?.().catch(() => {})), []);
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
  const [oldRating, setOldRating] = useState(profile.rating);
  const [ratingNote, setRatingNote] = useState<string | null>(null);
  const startedAt = useRef(Date.now());
  const [duration, setDuration] = useState(0);
  const movesRef = useRef<Move[]>(match?.initial.moves ?? []);
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
          const oppRating = mode === 'bot' ? bot!.rating : quick ? match!.opp.rating : remote!.oppRating;
          if (quick) {
            /* the server rated it: see the match sync below */
          } else if (config.account && supabase) void rateOnServer(r);
          else {
            const d = ratingChange(p.rating, oppRating, score, p.wins + p.losses + p.draws);
            setDelta(d);
            setProfile({
              ...p,
              rating: p.rating + d,
              wins: p.wins + (score === 1 ? 1 : 0),
              losses: p.losses + (score === 0 ? 1 : 0),
              draws: p.draws + (score === 0.5 ? 1 : 0),
              history: [
                { opp: mode === 'bot' ? bot!.name : quick ? match!.opp.display_name : remote!.oppName, result: (score === 1 ? 'win' : score === 0 ? 'loss' : 'draw') as 'win' | 'loss' | 'draw', delta: d, at: Date.now() },
                ...p.history,
              ].slice(0, 30),
            });
          }
        } else sfx('win');
        if (movesRef.current.length) setReview(reviewGame(rules, movesRef.current));
        setRevealed(true);
        window.setTimeout(() => setShowModal(true), 450);
      }, settle);
    },
    [bot, config.mySide, match, mode, quick, remote, rules, setProfile],
  );

  // Rated games for signed-in players are scored by the database, which replays the moves.
  async function rateOnServer(r: Result) {
    const moves = movesRef.current;
    let res: RatedResult | null = null;
    try {
      if (mode === 'bot') {
        const { data, error } = await supabase!.rpc('record_bot_game', {
          p_key: crypto.randomUUID(), p_bot: bot!.id, p_side: config.mySide, p_rules: rules, p_moves: moves, p_reason: r.reason,
        });
        if (error) throw error;
        res = data as RatedResult;
      } else if (mode === 'online') {
        if (!remote?.oppUid || !config.gameKey) return setRatingNote('Unrated: your friend is playing as a guest.');
        if (r.reason === 'abandonment') return setRatingNote('Unrated: your opponent left.');
        const args = { p_key: config.gameKey, p_opponent: remote.oppUid, p_side: config.mySide, p_rules: rules, p_moves: moves, p_winner: r.winner, p_reason: r.reason };
        for (let i = 0; i < 12; i++) {
          const { data, error } = await supabase!.rpc('report_online_game', args);
          if (error) throw error;
          res = data as RatedResult;
          if (res.status !== 'pending') break;
          setRatingNote(`Waiting for ${remote.oppName} to confirm the result…`);
          await new Promise((ok) => setTimeout(ok, 2500));
        }
      }
    } catch (e) {
      return setRatingNote(`Couldn't save the result: ${(e as Error).message}`);
    }
    if (!res) return;
    if (res.status === 'rated') {
      setRatingNote(null);
      setOldRating(res.before!);
      setDelta(res.delta!);
      config.account!.onRated();
    } else if (res.status === 'mismatch') setRatingNote("Unrated: the two screens didn't agree on the result.");
    else setRatingNote(`Unrated: ${remote?.oppName ?? 'your opponent'} never confirmed.`);
  }

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
      // The server ends quick-play games itself; we just show the move straight away.
      if (quick) {
        if (!fromRemote) void match!.move(moves.length, m).then((ok) => ok || syncRef.current(match!.latest(), true));
        return;
      }
      const w = winner(next);
      if (w !== null) return finish({ winner: w, reason: 'knockout' });
      const key = positionKey(next);
      if (newStates.filter((x) => positionKey(x) === key).length >= 3) finish({ winner: null, reason: 'repetition' });
    },
    [clocks, finish, live, match, mode, moves.length, quick, remote, result, rules, states],
  );

  // Quick play: the server's copy of the game wins. Catch up on the other side's moves, clocks, result and rating.
  const syncRef = useRef((_r: MatchRow, _force?: boolean) => {});
  syncRef.current = (r: MatchRow, force = false) => {
    const local = movesRef.current;
    const ahead = r.moves.length > local.length;
    const differs = r.moves.length === local.length && JSON.stringify(r.moves) !== JSON.stringify(local);
    // A shorter server list is normally just our own move still on its way, unless the server refused it.
    if (ahead || differs || (force && r.moves.length !== local.length)) {
      const st = statesFrom(rules, r.moves);
      movesRef.current = r.moves;
      setMoves(r.moves);
      setStates(st);
      setView(st.length - 1);
      setHint(null);
    }
    setClocks(clocksOf(r));
    lastMoveAt.current = Date.now() - (r.elapsed_ms ?? 0);
    const mine = config.mySide === 0 ? r.rematch_a : r.rematch_b;
    const theirs = config.mySide === 0 ? r.rematch_b : r.rematch_a;
    setRematchAsked({ me: mine, them: theirs });
    if (r.status !== 'active') {
      const before = config.mySide === 0 ? r.a_before : r.b_before;
      const d = config.mySide === 0 ? r.a_delta : r.b_delta;
      if (before !== null && d !== null && !ratedRef.current) {
        ratedRef.current = true;
        setOldRating(before);
        setDelta(d);
        config.account?.onRated();
      }
      finish({ winner: r.winner, reason: r.reason ?? 'aborted' });
    }
  };
  const ratedRef = useRef(false);
  const lastMoveAt = useRef(Date.now() - (match?.initial.elapsed_ms ?? 0));
  useEffect(() => {
    if (!match) return;
    syncRef.current(match.latest());
    return match.subscribe((r) => syncRef.current(r));
  }, [match]);

  // Quick play: if a clock runs out (or nobody starts), ask the server to call it.
  useEffect(() => {
    if (!quick || result) return;
    const id = window.setInterval(() => {
      const flagged = clocksRef.current.some((c) => c <= 0) && movesRef.current.length >= 2;
      const unstarted = movesRef.current.length < 2 && Date.now() - lastMoveAt.current > 30500;
      if (flagged || unstarted) match!.claimTimeout();
    }, 1000);
    return () => window.clearInterval(id);
  }, [match, quick, result]);
  const clocksRef = useRef(clocks);
  clocksRef.current = clocks;

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
      if (msg.t === 'chat') addLines([{ id: `p${Date.now()}${Math.random()}`, mine: false, body: cleanChat(msg.text) }]);
    });
  }, [config.clock, config.mySide, finish, remote]);

  useEffect(() => {
    if (remote && !remote.connected && !result && moves.length > 0) finish({ winner: config.mySide, reason: 'abandonment' });
  }, [config.mySide, finish, moves.length, remote, result]);

  useEffect(() => {
    if (!quick && rematchAsked.me && rematchAsked.them) onRematch(); // quick play: the app opens the server's rematch
  }, [onRematch, quick, rematchAsked]);

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
    if (!config.clock || result || quick) return;
    const flagged = clocks.findIndex((c) => c <= 0);
    if (flagged >= 0 && (mode !== 'online' || flagged === config.mySide)) {
      finish({ winner: other(flagged as Side), reason: 'time' });
      if (mode === 'online') remote!.send({ t: 'resign' });
    }
  }, [clocks, config.clock, config.mySide, finish, mode, quick, remote, result]);

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
    if (quick) return match!.resign(); // the server decides: resign, or call it off before both sides have moved
    const loser = mode === 'local' ? live.turn : config.mySide;
    if (mode === 'online') remote!.send({ t: 'resign' });
    finish({ winner: other(loser), reason: 'resignation' });
  };

  // ---------- chat (friend links over the peer connection, quick play through the server)
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);
  function addLines(ls: ChatLine[]) {
    setChat((prev) => {
      const ids = new Set(prev.map((l) => l.id));
      const fresh = ls.filter((l) => !ids.has(l.id));
      return fresh.length ? [...prev, ...fresh].slice(-100) : prev;
    });
  }
  const myId = match ? (match.mySide === 0 ? match.initial.player_a : match.initial.player_b) : null;
  useEffect(() => {
    if (!match || !chatOn) return;
    return watchChat(match.id, (rows: ChatRow[]) => addLines(rows.map((r) => ({ id: r.id, mine: r.sender === myId, body: r.body }))));
  }, [chatOn, match, myId]);
  const sayChat = (text: string) => {
    setChatError(null);
    if (quick)
      return void sendChat(match!.id, text).then(
        (r) => addLines([{ id: r.id, mine: true, body: r.body }]),
        (e: Error) => setChatError(e.message),
      );
    const body = cleanChat(text);
    remote!.send({ t: 'chat', text: body });
    addLines([{ id: `m${Date.now()}`, mine: true, body }]);
  };

  const rematch = () => {
    if (quick) return (match!.rematch(), setRematchAsked((r) => ({ ...r, me: true })));
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

  const oppName = quick ? match!.opp.display_name : remote?.oppName ?? '';
  const names: [string, string] =
    mode === 'local'
      ? ['Player 1', 'Player 2']
      : mode === 'bot'
        ? config.mySide === 0
          ? [profile.name, bot!.name]
          : [bot!.name, profile.name]
        : config.mySide === 0
          ? [profile.name, oppName]
          : [oppName, profile.name];
  // A matched stranger brings their own hands; otherwise pick a tone that contrasts with yours.
  const oppSkin = quick && match!.opp.skin !== profile.skin ? SKINS[match!.opp.skin] : SKINS[(profile.skin + 2) % SKINS.length];
  const skins: [string, string] =
    mode === 'local' ? [SKINS[profile.skin], oppSkin] : config.mySide === 0 ? [SKINS[profile.skin], oppSkin] : [oppSkin, SKINS[profile.skin]];
  const MY_SLEEVE = '#ecebe6';
  const oppSleeve = mode === 'bot' ? darken(bot!.color) : '#2a2826';
  const sleeves: [string, string] = mode === 'local' || config.mySide === 0 ? [MY_SLEEVE, oppSleeve] : [oppSleeve, MY_SLEEVE];

  const isBotSide = (s: Side) => mode === 'bot' && s !== config.mySide;
  const ratingOf = (s: Side) => (mode === 'local' ? null : isBotSide(s) ? bot!.rating : s === config.mySide ? profile.rating : quick ? match!.opp.rating : remote!.oppRating);
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
  const title = !result ? '' : result.reason === 'aborted' ? 'Game aborted' : result.winner === null ? 'Draw' : mode === 'local' ? `${names[result.winner]} wins` : meWon ? 'You won' : 'You lost';
  const timeLabel = config.clock ? clockLabel(config.clock) : null;
  const status = result ? null : canAct ? (mode === 'local' ? `${names[live.turn]} to move` : 'Your move') : mode === 'bot' ? `${bot!.name} is thinking…` : `${names[live.turn]} to move`;
  const mins = Math.floor(duration / 60000);
  const secs = Math.round((duration % 60000) / 1000);

  return (
    <div className={`game screen ${focus ? 'focus' : ''}`}>
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
            focus={focus}
            onFocus={toggleFocus}
          />
        </div>
        {playerBar(bottom)}
      </div>

      <aside className="panel">
        <div className="panel-top">
          <span className="chip">{describeRules(rules)}</span>
          {timeLabel && <span className="chip">{timeLabel}</span>}
          <button className="icon-btn sm" onClick={onExit} title="Leave game" aria-label="Leave game">
            <X size={16} />
          </button>
        </div>

        {!revealed && status && (
          <div className={`status ${canAct ? 'go' : ''}`}>
            {status}
            {moves.length > 0 && <span className="status-move">Move {Math.floor(moves.length / 2) + 1}</span>}
          </div>
        )}

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
            {ratingNote && <div className="rating-note">{ratingNote}</div>}
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

        <div className="movelist" ref={listRef}>
          {rows.length === 0 && <div className="empty">Moves will appear here.</div>}
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
              {!net && (
                <button className="tool" title="Hint" aria-label="Hint" disabled={!canAct} onClick={() => setHint(rankedMoves(rules, live)[0].move)}>
                  <Lightbulb size={18} />
                </button>
              )}
              <button className="tool" title="Switch seat" aria-label="Switch seat" onClick={() => setFlipped((f) => !f)}>
                <ArrowUpDown size={18} />
              </button>
              {!quick && (
                <button className={`tool ${showEval ? 'on' : ''}`} title="Evaluation bar" aria-label="Evaluation bar" onClick={() => setShowEval((s) => !s)}>
                  <BarChart3 size={18} />
                </button>
              )}
              <button className="tool danger" title="Resign" aria-label="Resign" onClick={resign} disabled={!!result}>
                <Flag size={18} />
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
        {rematchAsked.them && !rematchAsked.me && <div className="notice">{oppName} wants a rematch</div>}
        {remote && !remote.connected && <div className="notice warn">Opponent disconnected</div>}
        {net && chatOn && <Chat lines={chat} oppName={oppName} onSend={sayChat} error={chatError} />}
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
              {result.reason === 'aborted' ? '–' : result.winner === null ? '½ – ½' : `${result.winner === (config.mode === 'local' ? 0 : config.mySide) ? 1 : 0} – ${result.winner === (config.mode === 'local' ? 0 : config.mySide) ? 0 : 1}`}
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
          {ratingNote && <div className="rating-note center">{ratingNote}</div>}
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
export function moveText(m: Move) {
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
