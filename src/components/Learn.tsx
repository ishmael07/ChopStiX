import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowLeftRight, Hand, MousePointerClick } from 'lucide-react';
import { Table } from './Table';
import { applyMove, CLASSIC, MODES, type Move, type State } from '../game/rules';

interface Step {
  title: string;
  text: string;
  before: State;
  move: Move | null;
}

const S = (me: [number, number], them: [number, number]): State => ({ hands: [me, them], turn: 0 });

const STEPS: Step[] = [
  { title: 'Start with one up', text: 'Both players start with one finger raised on each hand.', before: S([1, 1], [1, 1]), move: null },
  { title: 'Tap to add', text: 'Tap one of their hands with yours. They add your fingers to theirs: 2 onto 1 makes 3.', before: S([2, 1], [1, 1]), move: { kind: 'attack', from: 0, to: 1 } },
  { title: 'Five knocks it out', text: 'A hand that reaches 5 or more is out. 3 onto 2 makes 5.', before: S([3, 1], [2, 1]), move: { kind: 'attack', from: 0, to: 0 } },
  { title: 'Or split', text: 'Instead of tapping, move fingers between your own hands. 1 and 3 can become 2 and 2.', before: S([1, 3], [2, 2]), move: { kind: 'split', to: [2, 2] } },
  { title: 'Take both to win', text: 'Knock out both of their hands and the game is yours.', before: S([2, 1], [0, 3]), move: { kind: 'attack', from: 0, to: 1 } },
];

export function Learn({ skin, onPlay }: { skin: string; onPlay: () => void }) {
  const [i, setI] = useState(0);
  const [tick, setTick] = useState(0); // even: before the move, odd: after
  const step = STEPS[i];

  // Loop each step: show the position, play the move, hold, repeat.
  useEffect(() => {
    setTick((t) => t + (t % 2 === 0 ? 2 : 1));
    if (!step.move) return;
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
  }, [i, step.move]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setI((x) => Math.min(STEPS.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const played = tick % 2 === 1 && step.move;
  const state = played ? applyMove(CLASSIC, step.before, step.move!) : step.before;
  const last = i === STEPS.length - 1;

  return (
    <div className="learn2 screen">
      <section className="tour">
        <div className="tour-board">
          <Table
            demo
            state={state}
            rules={CLASSIC}
            bottom={0}
            canAct={false}
            lastMove={played ? step.move : null}
            ply={tick}
            skins={[skin, '#a26b45']}
            sleeves={['#ecebe6', '#2b2b2e']}
            view="2d"
            onView={() => {}}
            onMove={() => {}}
          />
        </div>

        <div className="tour-copy">
          <span className="tour-count">
            {i + 1} / {STEPS.length}
          </span>
          <h1 key={`t${i}`}>{step.title}</h1>
          <p key={`p${i}`}>{step.text}</p>
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
