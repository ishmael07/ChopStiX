import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Video, X, ArrowLeftRight } from 'lucide-react';
import { HandImage } from './Hand';
import { Seg } from './ui';
import { legalMoves, other, splitOptions, type Hands, type Move, type Rules, type Side, type State } from '../game/rules';
import type { CameraMode, HandFlags, HandKey, Motion, Scene3D } from '../three/scene3d';
import { sfx } from '../sound';

export type ViewMode = '2d' | '3d';
const CONTACT_MS = 270; // when a tap lands (matches the 3D strike timing)
const CAMERA_ORDER: CameraMode[] = ['player', 'top', 'low'];
const CAMERA_NAME: Record<CameraMode, string> = { player: 'Seated', top: 'Overhead', low: 'Low' };

interface Props {
  state: State;
  rules: Rules;
  bottom: Side;
  canAct: boolean;
  lastMove: Move | null;
  ply: number;
  skins: [string, string];
  sleeves: [string, string];
  hint?: Move | null;
  view: ViewMode;
  onView: (v: ViewMode) => void;
  onMove: (m: Move) => void;
  demo?: boolean; // non-interactive showcase (home screen)
}

type Pop = { id: number; key: HandKey; text: string; kill: boolean };
type MotionEvt = Motion & { id: number };

interface BoardProps {
  shown: State;
  bottom: Side;
  skins: [string, string];
  sleeves: [string, string];
  flags: (side: Side, hand: 0 | 1) => HandFlags;
  onHand: (side: Side, hand: 0 | 1) => void;
  onDrag: (from: HandKey, to: HandKey) => void;
  motion: MotionEvt | null;
  hit: HandKey | null;
  pops: Pop[];
}

const keyOf = (side: Side, hand: 0 | 1) => `${side}${hand}` as HandKey;
const parse = (k: HandKey) => [Number(k[0]) as Side, Number(k[1]) as 0 | 1] as const;

function loadCamera(): CameraMode {
  try {
    const c = localStorage.getItem('chopstix.camera') as CameraMode | null;
    return c && CAMERA_ORDER.includes(c) ? c : 'player';
  } catch {
    return 'player';
  }
}

export function Table({ state, rules, bottom, canAct, lastMove, ply, skins, sleeves, hint, view, onView, onMove, demo }: Props) {
  const [shown, setShown] = useState(state);
  const [sel, setSel] = useState<0 | 1 | null>(null);
  const [transfer, setTransfer] = useState<Hands | null>(null);
  const [motion, setMotion] = useState<MotionEvt | null>(null);
  const [hit, setHit] = useState<HandKey | null>(null);
  const [pops, setPops] = useState<Pop[]>([]);
  const [camera, setCameraState] = useState<CameraMode>(loadCamera);
  const prevPly = useRef(ply);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // Play the move that produced `state`, then reveal the new finger counts on contact.
  useLayoutEffect(() => {
    setSel(null);
    setTransfer(null);
    const forward = ply === prevPly.current + 1;
    prevPly.current = ply;
    if (!forward || !lastMove) return setShown(state);
    const mover = other(state.turn);
    let to: HandKey | null = null;
    if (lastMove.kind === 'split') setMotion({ id: ply, kind: 'split', side: mover });
    else {
      to = lastMove.kind === 'attack' ? keyOf(state.turn, lastMove.to) : keyOf(mover, (1 - lastMove.from) as 0 | 1);
      setMotion({ id: ply, kind: lastMove.kind, from: keyOf(mover, lastMove.from), to });
    }
    const timer = window.setTimeout(() => {
      if (!to) {
        sfx('split');
        return setShown(state);
      }
      const [ts, th] = parse(to);
      const before = shownRef.current.hands[ts][th];
      const after = state.hands[ts][th];
      const kill = after === 0;
      sfx(kill ? 'kill' : 'tap');
      setShown(state);
      setHit(to);
      const id = Date.now();
      setPops((p) => [...p, { id, key: to!, kill, text: kill ? 'Out' : `+${(after - before + 5) % 5 || 5}` }]);
      window.setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 900);
      window.setTimeout(() => setHit(null), 380);
    }, CONTACT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ply, state]);

  useEffect(() => {
    if (!canAct) setSel(null), setTransfer(null);
  }, [canAct]);

  const me = state.turn;
  const moves = canAct ? legalMoves(rules, state) : [];
  const splits = canAct ? splitOptions(rules, state.hands[me]) : [];
  const has = (m: Move) => moves.some((x) => JSON.stringify(x) === JSON.stringify(m));
  const cur = state.hands[me];
  const legalTransfer = transfer !== null && splits.some((s) => s[0] === transfer[0] && s[1] === transfer[1]);

  function startTransfer(from?: 0 | 1) {
    if (!splits.length) return;
    setSel(null);
    // Start by moving one finger from the chosen hand, the way you would in real life.
    const t: Hands = [...cur];
    if (from !== undefined && t[from] > 0 && t[1 - from] < 4) (t[from] -= 1), (t[1 - from] += 1);
    setTransfer(t);
    sfx('select');
  }

  function shift(dir: -1 | 1) {
    // dir -1: move a finger to the left hand, +1: to the right hand
    setTransfer((t) => {
      if (!t) return t;
      const total = t[0] + t[1];
      const l = Math.max(Math.max(0, total - 4), Math.min(Math.min(4, total), t[0] - dir));
      if (l !== t[0]) sfx('select');
      return [l, total - l];
    });
  }

  function act(from: HandKey, to: HandKey) {
    const [fs, fh] = parse(from);
    const [ts, th] = parse(to);
    if (!canAct || fs !== me || shown.hands[fs][fh] === 0) return;
    if (ts !== me) {
      if (has({ kind: 'attack', from: fh, to: th })) onMove({ kind: 'attack', from: fh, to: th });
    } else if (fh !== th) {
      if (has({ kind: 'self', from: fh })) onMove({ kind: 'self', from: fh });
      else startTransfer(fh);
    }
  }

  function onHand(side: Side, hand: 0 | 1) {
    if (!canAct || transfer) return;
    if (side === me) {
      if (sel === null) {
        if (state.hands[me][hand] > 0) setSel(hand), sfx('select');
        else startTransfer((1 - hand) as 0 | 1);
      } else if (sel === hand) setSel(null);
      else act(keyOf(me, sel), keyOf(me, hand));
      return;
    }
    if (sel !== null) act(keyOf(me, sel), keyOf(side, hand));
  }

  // Keyboard: S to split, arrows to move fingers, Enter to confirm, Esc to cancel.
  useEffect(() => {
    if (demo) return;
    const onKey = (e: KeyboardEvent) => {
      if (!canAct) return;
      if (transfer) {
        if (e.key === 'ArrowLeft') (shift(-1), e.preventDefault(), e.stopImmediatePropagation());
        if (e.key === 'ArrowRight') (shift(1), e.preventDefault(), e.stopImmediatePropagation());
        if (e.key === 'Enter' && legalTransfer) onMove({ kind: 'split', to: transfer });
        if (e.key === 'Escape') setTransfer(null);
      } else {
        if (e.key.toLowerCase() === 's') startTransfer();
        if (e.key === 'Escape') setSel(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const display: State = transfer ? { ...shown, hands: (me === 0 ? [transfer, shown.hands[1]] : [shown.hands[0], transfer]) as State['hands'] } : shown;

  const flags = (side: Side, hand: 0 | 1): HandFlags => {
    const mine = canAct && side === me && !transfer;
    const count = shown.hands[side][hand];
    const selfOk = sel !== null && has({ kind: 'self', from: sel });
    const lastFrom = lastMove && lastMove.kind !== 'split' ? keyOf(other(state.turn), lastMove.from) : null;
    const lastTo =
      lastMove?.kind === 'attack' ? keyOf(state.turn, lastMove.to) : lastMove?.kind === 'self' ? keyOf(other(state.turn), (1 - lastMove.from) as 0 | 1) : null;
    return {
      selectable: mine && (count > 0 || splits.length > 0),
      selected: mine && sel === hand,
      target: canAct && !transfer && sel !== null && ((side !== me && count > 0) || (side === me && hand !== sel && (selfOk || splits.length > 0))),
      hinted:
        !!hint &&
        !transfer &&
        ((hint.kind !== 'split' && side === me && hint.from === hand) || (hint.kind === 'attack' && side !== me && hint.to === hand) || (hint.kind === 'split' && side === me)),
      last: !demo && (keyOf(side, hand) === lastFrom || keyOf(side, hand) === lastTo),
    };
  };

  const setCamera = (c: CameraMode) => {
    setCameraState(c);
    try {
      localStorage.setItem('chopstix.camera', c);
    } catch {
      /* ignore */
    }
  };

  const board: BoardProps = { shown: display, bottom, skins, sleeves, flags, onHand, onDrag: act, motion, hit, pops };

  return (
    <div className={`table view-${view} ${demo ? 'demo' : ''}`}>
      {view === '3d' ? <Board3D {...board} camera={camera} onFail={() => onView('2d')} /> : <Board2D {...board} />}

      {!demo && (
        <div className="board-tools">
          <Seg
            size="mini"
            value={view}
            onChange={onView}
            options={[
              { value: '2d', label: '2D' },
              { value: '3d', label: '3D' },
            ]}
          />
          {view === '3d' && (
            <button className="tool-btn" title={`Camera: ${CAMERA_NAME[camera]} (click to change)`} aria-label="Change camera angle" onClick={() => setCamera(CAMERA_ORDER[(CAMERA_ORDER.indexOf(camera) + 1) % 3])}>
              <Video size={15} />
            </button>
          )}
        </div>
      )}

      {canAct && !demo && (
        <div className={`dock ${me === bottom ? 'near' : 'far'}`}>
          {transfer ? (
            <div className="transfer">
              <button className="round" onClick={() => shift(-1)} aria-label="Move a finger left">
                <ArrowLeft size={18} />
              </button>
              <div className="transfer-count">
                <b>{transfer[0]}</b>
                <span>·</span>
                <b>{transfer[1]}</b>
              </div>
              <button className="round" onClick={() => shift(1)} aria-label="Move a finger right">
                <ArrowRight size={18} />
              </button>
              <span className="divider" />
              <button className="round confirm" disabled={!legalTransfer} onClick={() => transfer && onMove({ kind: 'split', to: transfer })} aria-label="Confirm split">
                <Check size={18} />
              </button>
              <button className="round" onClick={() => setTransfer(null)} aria-label="Cancel">
                <X size={18} />
              </button>
            </div>
          ) : (
            splits.length > 0 && (
              <button className="dock-btn" onClick={() => startTransfer()}>
                <ArrowLeftRight size={16} /> Split
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- 2D ---------------- */

function Board2D({ shown, bottom, skins, sleeves, flags, onHand, onDrag, motion, hit, pops }: BoardProps) {
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  const drag = useRef<{ key: HandKey; x: number; y: number } | null>(null);
  const dragged = useRef(false);

  useLayoutEffect(() => {
    if (!motion) return;
    const opts = { duration: 640, easing: 'cubic-bezier(.45,0,.2,1)' };
    if (motion.kind === 'split') {
      const keys: HandKey[] = [keyOf(motion.side, 0), keyOf(motion.side, 1)];
      const [a, b] = keys.map((k) => refs.current[k]);
      if (!a || !b) return;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const gap = (rb.left - ra.left) * 0.28;
      for (const [el, dir] of [[a, 1], [b, -1]] as const)
        el.animate(
          [{ transform: 'none' }, { transform: `translateX(${gap * dir}px) rotate(${dir * -6}deg) scale(1.03)`, offset: 0.42 }, { transform: 'none' }],
          opts,
        );
      return;
    }
    const a = refs.current[motion.from];
    const t = refs.current[motion.to];
    if (!a || !t) return;
    const ra = a.getBoundingClientRect();
    const rt = t.getBoundingClientRect();
    const self = motion.kind === 'self';
    const k = self ? 0.55 : 0.6;
    const near = a.closest('.near') ? -1 : 1;
    const dx = (rt.left + rt.width / 2 - (ra.left + ra.width / 2)) * k;
    const dy = (rt.top + rt.height / 2 - (ra.top + ra.height / 2)) * k + (self ? near * 36 : 0);
    a.animate(
      [
        { transform: 'none' },
        { transform: `translate(${-dx * 0.08}px,${-dy * 0.08}px) scale(1.02)`, offset: 0.14 },
        { transform: `translate(${dx}px,${dy}px) scale(1.04) rotate(${self ? (dx > 0 ? 9 : -9) : 0}deg)`, offset: 0.42 },
        { transform: `translate(${dx * 0.96}px,${dy * 0.96}px) scale(1)`, offset: 0.55 },
        { transform: 'none' },
      ],
      opts,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motion?.id]);

  const handAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest('[data-hand]') as HTMLElement | null;
    return (el?.dataset.hand as HandKey | undefined) ?? null;
  };

  const order = (side: Side): (0 | 1)[] => (side === bottom ? [0, 1] : [1, 0]);
  const row = (side: Side) => (
    <div className={`hand-row ${side === bottom ? 'near' : 'far'}`}>
      {order(side).map((h) => {
        const key = keyOf(side, h);
        const count = shown.hands[side][h];
        const f = flags(side, h);
        return (
          <div className="hand-slot" key={key} data-hand={key} ref={(el) => void (refs.current[key] = el)}>
            <button
              className={['hand', f.selectable && 'selectable', f.selected && 'selected', f.target && 'target', hit === key && 'hit', f.hinted && 'hinted', f.last && 'last', count === 0 && 'is-dead']
                .filter(Boolean)
                .join(' ')}
              onPointerDown={(e) => (drag.current = { key, x: e.clientX, y: e.clientY })}
              onPointerUp={(e) => {
                const d = drag.current;
                drag.current = null;
                if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) {
                  dragged.current = true;
                  const to = handAt(e.clientX, e.clientY);
                  if (to && to !== d.key) onDrag(d.key, to);
                }
              }}
              onClick={() => {
                // a drag already acted; otherwise this is a tap, click or keyboard press
                if (dragged.current) dragged.current = false;
                else onHand(side, h);
              }}
              aria-label={`${h === 0 ? 'Left' : 'Right'} hand, ${count} finger${count === 1 ? '' : 's'}`}
            >
              <span className="ring" />
              <div className={`hand-art ${side === bottom ? '' : 'flip'}`}>
                <HandImage count={count} hand={h} skin={skins[side]} sleeve={sleeves[side]} />
              </div>
            </button>
            <span className={`count-chip ${count === 0 ? 'dead' : ''} ${hit === key ? 'bump' : ''}`}>{count === 0 ? '×' : count}</span>
            {pops
              .filter((p) => p.key === key)
              .map((p) => (
                <span key={p.id} className={`pop ${p.kill ? 'kill' : ''}`}>
                  {p.text}
                </span>
              ))}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <div className="felt" />
      <div className="table-inner">
        {row(other(bottom))}
        <div className="table-mid" />
        {row(bottom)}
      </div>
    </>
  );
}

/* ---------------- 3D ---------------- */

function Board3D({ shown, bottom, skins, sleeves, flags, onHand, onDrag, motion, hit, pops, camera, onFail }: BoardProps & { camera: CameraMode; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene3D | null>(null);
  const chips = useRef<Record<string, HTMLSpanElement | null>>({});
  const screen = useRef<Record<string, { x: number; y: number }>>({});
  const [ready, setReady] = useState(false);
  const cb = useRef({ onHand, onDrag });
  cb.current = { onHand, onDrag };
  const input = { hands: shown.hands, bottom, skins, sleeves, flags };
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    let s: Scene3D | null = null;
    let cancelled = false;
    import('../three/scene3d')
      .then(({ Scene3D }) => {
        if (cancelled) return;
        s = new Scene3D(host.current!, camera);
        scene.current = s;
        s.onHand = (side, hand) => cb.current.onHand(side, hand);
        s.onDrag = (a, b) => cb.current.onDrag(a, b);
        s.onFrame = (pos) => {
          screen.current = pos;
          for (const [k, p] of Object.entries(pos)) {
            const el = chips.current[k];
            if (el) el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
          }
        };
        s.update(inputRef.current);
        s.ready.then(() => !cancelled && setReady(true)).catch(onFail);
      })
      .catch(onFail);
    return () => {
      cancelled = true;
      s?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scene.current?.update(input);
  });
  useEffect(() => {
    scene.current?.setCamera(camera);
  }, [camera]);
  useEffect(() => {
    if (motion) scene.current?.play(motion);
  }, [motion]);

  const keys: HandKey[] = ['00', '01', '10', '11'];
  return (
    <>
      <div className="three-host" ref={host} />
      <div className={`three-loading ${ready ? 'gone' : ''}`}>
        <span className="spinner" />
      </div>
      <div className="three-overlay">
        {keys.map((k) => {
          const [s, h] = parse(k);
          const count = shown.hands[s][h];
          return (
            <span key={k} ref={(el) => void (chips.current[k] = el)} className={`count-chip c3d ${count === 0 ? 'dead' : ''} ${hit === k ? 'bump' : ''}`}>
              {count === 0 ? '×' : count}
            </span>
          );
        })}
        {pops.map((p) => {
          const pos = screen.current[p.key];
          return (
            pos && (
              <span key={p.id} className={`pop p3d ${p.kill ? 'kill' : ''}`} style={{ left: pos.x, top: pos.y - 70 }}>
                {p.text}
              </span>
            )
          );
        })}
      </div>
    </>
  );
}
