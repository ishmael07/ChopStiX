import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Eye, Flame, RotateCcw } from 'lucide-react';
import { Table, type ViewMode } from './Table';
import { moveText } from './Game';
import { Seg } from './ui';
import { SKINS } from '../game/profile';
import { applyMove, winner, type Move, type State } from '../game/rules';
import { rankedMoves, scoreMove } from '../game/solver';
import { dailyPuzzle, nextPuzzle, submitPuzzle, type Daily, type Puzzle, type PuzzleResult } from '../net/social';
import { sfx } from '../sound';

type Tab = 'daily' | 'rated';
type Status = 'solving' | 'wrong' | 'solved' | 'watching';

const VARIANT: Record<string, string> = {
  classic: 'Classic rules',
  street: 'Lunch Table rules: free swaps',
  rollover: 'Rollover: past 5 wraps around (6 → 1)',
  selftap: 'Self-taps: you may tap your own hand',
  nosplit: 'No splitting',
};

const startOf = (p: Puzzle): State => ({ hands: p.hands, turn: 0 });
const best = (p: Puzzle, s: State) => rankedMoves(p.rules, s)[0].move;

/** The whole line the puzzle wants: your fastest win against the toughest defence. */
function solution(p: Puzzle) {
  const out: Move[] = [];
  let s = startOf(p);
  while (winner(s) === null && out.length < 40) {
    const m = best(p, s);
    out.push(m);
    s = applyMove(p.rules, s, m);
  }
  return out;
}

export function Puzzles({
  signedIn,
  skin,
  view,
  onView,
  onSignUp,
  onProgress,
}: {
  signedIn: boolean;
  skin: number;
  view: ViewMode;
  onView: (v: ViewMode) => void;
  onSignUp: () => void;
  /** Ratings or streak changed on the server. */
  onProgress: () => void;
}) {
  const [tab, setTab] = useState<Tab>('daily');
  const [daily, setDaily] = useState<Daily | null>(null);
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [states, setStates] = useState<State[]>([]);
  const [moves, setMoves] = useState<Move[]>([]);
  const [status, setStatus] = useState<Status>('solving');
  const [result, setResult] = useState<PuzzleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0); // remounts the board for a fresh start
  const timers = useRef<number[]>([]);
  const clearTimers = () => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
  };
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  const load = useCallback((p: Puzzle) => {
    clearTimers();
    setPuzzle(p);
    setStates([startOf(p)]);
    setMoves([]);
    setStatus('solving');
    setResult(null);
    setRound((r) => r + 1);
  }, []);

  useEffect(() => {
    setError(null);
    const req = tab === 'daily' ? dailyPuzzle().then((d) => (setDaily(d), d.puzzle)) : nextPuzzle();
    req.then(load, (e: Error) => setError(e.message));
  }, [tab, load]);

  const live = states[states.length - 1];

  const submit = (line: Move[]) =>
    submitPuzzle(puzzle!.id, line).then(
      (r) => {
        setResult(r);
        if (r.daily) setDaily((d) => d && { ...d, solved_today: d.solved_today || r.solved, streak: r.streak ?? d.streak, best_streak: r.best_streak ?? d.best_streak });
        onProgress();
      },
      (e: Error) => setError(e.message),
    );

  function play(m: Move) {
    if (!puzzle || status !== 'solving' || live.turn !== 0) return;
    const ranked = rankedMoves(puzzle.rules, live);
    const right = scoreMove(puzzle.rules, live, m) === ranked[0].score;
    const next = applyMove(puzzle.rules, live, m);
    const line = [...moves, m];
    setStates([...states, next]);
    setMoves(line);
    if (!right) {
      sfx('lose');
      setStatus('wrong');
      return void submit(line);
    }
    if (winner(next) !== null) {
      sfx('win');
      setStatus('solved');
      return void submit(line);
    }
    // Their toughest defence, after a beat.
    timers.current.push(
      window.setTimeout(() => {
        const reply = best(puzzle, next);
        setStates((st) => [...st, applyMove(puzzle.rules, next, reply)]);
        setMoves((ms) => [...ms, reply]);
      }, 650),
    );
  }

  /** Play the answer from the start. */
  function watch() {
    if (!puzzle) return;
    clearTimers();
    const line = solution(puzzle);
    setStates([startOf(puzzle)]);
    setMoves([]);
    setStatus('watching');
    setRound((r) => r + 1);
    line.forEach((_, i) =>
      timers.current.push(
        window.setTimeout(() => {
          const sts = [startOf(puzzle)];
          for (const m of line.slice(0, i + 1)) sts.push(applyMove(puzzle.rules, sts[sts.length - 1], m));
          setStates(sts);
          setMoves(line.slice(0, i + 1));
        }, 900 + i * 1100),
      ),
    );
  }

  const retry = () => puzzle && load(puzzle);
  const next = () => {
    if (tab === 'rated') nextPuzzle(puzzle?.id).then(load, (e: Error) => setError(e.message));
    else setTab('rated');
  };

  const mySkin = SKINS[skin];
  const oppSkin = SKINS[(skin + 2) % SKINS.length];
  const yourTurn = status === 'solving' && live?.turn === 0;
  const streak = daily?.streak ?? 0;

  return (
    <div className="game screen puzzles">
      <div className="board-col">
        <div className="player-bar">
          <span className="pz-side">Them</span>
        </div>
        <div className="board-wrap">
          {puzzle ? (
            <Table
              key={round}
              state={live}
              rules={puzzle.rules}
              bottom={0}
              canAct={yourTurn}
              lastMove={moves.length ? moves[moves.length - 1] : null}
              ply={moves.length}
              skins={[mySkin, oppSkin]}
              sleeves={['#ecebe6', '#2a2826']}
              view={view}
              onView={onView}
              onMove={play}
            />
          ) : (
            <div className="table-placeholder" />
          )}
        </div>
        <div className={`player-bar ${yourTurn ? 'active' : ''}`}>
          <span className="pz-side">You</span>
          {yourTurn && <span className="turn-dot" />}
        </div>
      </div>

      <aside className="panel pz-panel">
        <div className="pz-top">
          <Seg
            value={tab}
            onChange={setTab}
            options={[
              { value: 'daily', label: 'Daily' },
              { value: 'rated', label: 'Puzzles' },
            ]}
          />
        </div>

        {tab === 'daily' && (
          <div className="pz-streak">
            <Flame size={22} className={streak > 0 ? 'lit' : ''} />
            <div>
              <b>{streak > 0 ? `${streak} day streak` : 'No streak yet'}</b>
              <span>{signedIn ? (daily?.solved_today ? 'Solved today. Come back tomorrow.' : 'Solve today’s puzzle to keep it going.') : 'Sign up to keep a streak.'}</span>
            </div>
          </div>
        )}

        {puzzle && (
          <div className="pz-brief">
            <h2>
              Win in {puzzle.moves}
              <span className="pz-rating">{puzzle.rating}</span>
            </h2>
            <p>{VARIANT[puzzle.mode] ?? ''}</p>
            <p className="muted">You move first. Find the fastest knockout; they’ll defend as well as they can.</p>
          </div>
        )}

        <div className="pz-feedback">
          {error && <div className="notice warn">{error}</div>}
          {status === 'solving' && moves.length > 0 && <div className="notice ok">Good. Keep going.</div>}
          {status === 'wrong' && (
            <div className="notice warn">
              {moveText(moves[moves.length - 1])} isn’t the fastest win. The best move was <b>{moveText(best(puzzle!, states[states.length - 2]))}</b>.
            </div>
          )}
          {status === 'solved' && <div className="notice ok big">Solved!</div>}
          {result && result.status === 'rated' && (
            <div className="pz-result">
              Puzzle rating <b>{result.puzzle_rating}</b>
              <span className={`delta ${result.delta! >= 0 ? 'up' : 'down'}`}>
                {result.delta! >= 0 ? '+' : ''}
                {result.delta}
              </span>
            </div>
          )}
          {result?.status === 'practice' && <p className="muted">Practice: only your first try at a puzzle is rated.</p>}
          {result?.daily && result.solved && <p className="pz-streak-up">🔥 {result.streak} day streak</p>}
          {result?.status === 'guest' && (
            <button className="link-btn" onClick={onSignUp}>
              Sign up to get a puzzle rating and keep a streak
            </button>
          )}
        </div>

        <div className="pz-actions">
          {(status === 'wrong' || status === 'solved' || status === 'watching') && (
            <>
              <button className="btn" onClick={retry}>
                <RotateCcw size={16} /> Try again
              </button>
              {status !== 'watching' && (
                <button className="btn" onClick={watch}>
                  <Eye size={16} /> Solution
                </button>
              )}
            </>
          )}
          <button className={`btn ${status === 'solving' ? '' : 'primary'}`} onClick={next}>
            {tab === 'daily' ? 'More puzzles' : 'Next puzzle'} <ArrowRight size={16} />
          </button>
        </div>
      </aside>
    </div>
  );
}

