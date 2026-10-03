import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowLeftRight, Check, Hand, Lightbulb, MousePointerClick } from 'lucide-react';
import { sfx } from '../sound';
import { Table } from './Table';
import { applyMove, CLASSIC, MODES, type Move, type State } from '../game/rules';

interface Step {
  title: string;
  text: string;
  before: State;
  move: Move | null;
  task?: string; // what to do in "Try it"
}

const S = (me: [number, number], them: [number, number]): State => ({ hands: [me, them], turn: 0 });

const STEPS: Step[] = [
  { title: 'Start with one up', text: 'Both players start with one finger raised on each hand.', before: S([1, 1], [1, 1]), move: null },
  { title: 'Tap to add', text: 'Tap one of their hands with yours. They add your fingers to theirs: 2 onto 1 makes 3.', before: S([2, 1], [1, 1]), move: { kind: 'attack', from: 0, to: 1 }, task: 'Tap any of their hands with your 2.' },
  { title: 'Five knocks it out', text: 'A hand that reaches 5 or more is out. 3 onto 2 makes 5.', before: S([3, 1], [2, 1]), move: { kind: 'attack', from: 0, to: 0 }, task: 'Knock out a hand: hit their 2 with your 3.' },
  { title: 'Or split', text: 'Instead of tapping, move fingers between your own hands. 1 and 3 can become 2 and 2.', before: S([1, 3], [2, 2]), move: { kind: 'split', to: [2, 2] }, task: 'Press Split and even your hands out to 2 and 2.' },
  { title: 'Take both to win', text: 'Knock out both of their hands and the game is yours.', before: S([2, 1], [0, 3]), move: { kind: 'attack', from: 0, to: 1 }, task: 'Finish it: knock out their last hand.' },
];

export function Learn({ skin, onPlay }: { skin: string; onPlay: () => void }) {
  const [i, setI] = useState(0);
  const [tick, setTick] = useState(0); // even: before the move, odd: after
  const [trying, setTrying] = useState<null | 'go' | 'done' | 'nope'>(null);
  const [tryState, setTryState] = useState<State | null>(null);
  const [tryMove, setTryMove] = useState<Move | null>(null);
  const step = STEPS[i];
  useEffect(() => {
    setTrying(null);
    setTryState(null);
    setTryMove(null);
  }, [i]);

  // A try succeeds if it reaches the same position the lesson's move does.
  function attempt(m: Move) {
    const goal = applyMove(CLASSIC, step.before, step.move!);
    const got = applyMove(CLASSIC, step.before, m);
    setTryMove(m);
    setTryState(got);
    setTick((t) => t + 1); // +1 so the board animates the tap
    // either of their hands counts, so compare positions with each side's hands sorted
    const norm = (st: State) => JSON.stringify(st.hands.map((h) => [...h].sort()));
    if (norm(goal) === norm(got)) {
      setTrying('done');
      sfx('win');
    } else {
      setTrying('nope');
      window.setTimeout(() => {
        setTryState(null);
        setTryMove(null);
        setTick((t) => t + 2);
        setTrying('go');
      }, 1500);
    }
  }

  // Loop each step: show the position, play the move, hold, repeat.
  useEffect(() => {
    setTick((t) => t + (t % 2 === 0 ? 2 : 1));
    if (!step.move || trying) return;
    let t1 = 0;
    const loop = () => {
      t1 = window.setTimeout(() => {
        setTick((t) => t + 1); // play the move
        t1 = window.setTimeout(() => {
          setTick((t) => t + 1); // back to the start
          loop();
        }, 2400);
      }, 1100);
    };
    loop();
    return () => window.clearTimeout(t1);
  }, [i, step.move, trying]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setI((x) => Math.min(STEPS.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const played = !trying && tick % 2 === 1 && step.move;
  const state = trying ? tryState ?? step.before : played ? applyMove(CLASSIC, step.before, step.move!) : step.before;
  const lastMove = trying ? tryMove : played ? step.move : null;
  const last = i === STEPS.length - 1;

  return (
    <div className="learn2 screen">
      <section className="tour">
        <div className="tour-board">
          <Table
            demo={trying !== 'go'}
            state={state}
            rules={CLASSIC}
            bottom={0}
            canAct={trying === 'go'}
            lastMove={lastMove}
            ply={tick}
            skins={[skin, '#a26b45']}
            sleeves={['#ecebe6', '#2b2b2e']}
            view="2d"
            onView={() => {}}
            onMove={attempt}
          />
          {trying && (
            <div className={`try-banner ${trying}`} key={trying}>
              {trying === 'done' ? (
                <>
                  <Check size={18} /> Nice. That&apos;s it.
                </>
              ) : trying === 'nope' ? (
                'Not quite. Try again.'
              ) : (
                step.task
              )}
            </div>
          )}
        </div>

        <div className="tour-copy">
          <span className="tour-count">
            {i + 1} / {STEPS.length}
          </span>
          <h1 key={`t${i}`}>{step.title}</h1>
          <p key={`p${i}`}>{step.text}</p>
          {step.task && (
            <button className={`try-btn ${trying === 'done' ? 'done' : ''}`} onClick={() => (setTryState(null), setTryMove(null), setTick((t) => t + 2), setTrying('go'))} disabled={trying === 'go'}>
              {trying === 'done' ? (
                <>
                  <Check size={16} /> Done · try again
                </>
              ) : trying ? (
                'Your turn…'
              ) : (
                <>
                  <Hand size={16} /> Try it yourself
                </>
              )}
            </button>
          )}
          <div className="tour-nav">
            <button className="round ghosty" onClick={() => setI(i - 1)} disabled={i === 0} aria-label="Previous step">
              <ArrowLeft size={18} />
            </button>
            <div className="tour-dots">
              {STEPS.map((_, k) => (
                <button key={k} className={k === i ? 'on' : ''} onClick={() => setI(k)} aria-label={`Step ${k + 1}`} />
              ))}
            </div>
            {last ? (
              <button className="btn primary" onClick={onPlay}>
                Play now
              </button>
            ) : (
              <button className="round next" onClick={() => setI(i + 1)} aria-label="Next step">
                <ArrowRight size={18} />
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="learn-more">
        <div className="lm-card">
          <h3>Two rule sets</h3>
          {(['classic', 'street'] as const).map((id) => (
            <div className="lm-row" key={id}>
              <b>{MODES[id].name}</b>
              <span>{id === 'classic' ? 'Splits must change something. No flipping or emptying a hand.' : 'Swap freely, flip 3-1 into 1-3, even empty a hand.'}</span>
            </div>
          ))}
        </div>
        <div className="lm-card">
          <h3>Quick tips</h3>
          <div className="lm-row icon">
            <Lightbulb size={18} />
            <span>Don&apos;t leave a hand where one tap makes 5. A 4 next to their 1 is a gift.</span>
          </div>
          <div className="lm-row icon">
            <Lightbulb size={18} />
            <span>Splitting a big hand into two small ones is often the safest move.</span>
          </div>
          <div className="lm-row icon">
            <Lightbulb size={18} />
            <span>With perfect play it&apos;s a draw. Every win comes from someone&apos;s mistake.</span>
          </div>
        </div>
        <div className="lm-card">
          <h3>Controls</h3>
          <div className="lm-row icon">
            <MousePointerClick size={18} />
            <span>Click your hand, then theirs. Or drag one onto the other.</span>
          </div>
          <div className="lm-row icon">
            <ArrowLeftRight size={18} />
            <span>
              Press <kbd>Split</kbd> or <kbd>S</kbd>, move fingers with <kbd>←</kbd> <kbd>→</kbd>, confirm with <kbd>Enter</kbd>.
            </span>
          </div>
          <div className="lm-row icon">
            <Hand size={18} />
            <span>Stuck? Hint shows the best move.</span>
          </div>
        </div>
      </section>
    </div>
  );
}
