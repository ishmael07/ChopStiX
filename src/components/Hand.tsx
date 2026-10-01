import { useEffect, useState } from 'react';

// Flat, clean illustration of a hand seen from above: the back of a LEFT hand,
// fingers pointing away, thumb tucked along the right edge. Right hands are
// mirrored. Folded fingers slide down behind the palm and show as knuckles.

const PALM_TOP = 112;

// pinky, ring, middle, index
const FINGERS = [
  { cx: 61, w: 28, top: 56, rot: -6 },
  { cx: 90, w: 30.5, top: 28, rot: -2 },
  { cx: 120, w: 31, top: 18, rot: 1 },
  { cx: 149.5, w: 30, top: 36, rot: 4.5 },
];
const RAISE_ORDER = [3, 2, 1, 0]; // index first, pinky last

function tone(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export function HandSVG({
  count,
  mirror,
  skin,
  sleeve,
}: {
  count: number;
  mirror: boolean;
  skin: string;
  sleeve?: string;
  uid?: string;
}) {
  const shade = tone(skin, -0.1);
  const deep = tone(skin, -0.2);
  const nail = tone(skin, 0.38);
  const raised = new Set(RAISE_ORDER.slice(0, count));

  return (
    <svg viewBox="0 0 210 300" className={`hand-svg ${count === 0 ? 'dead' : ''}`} aria-hidden>
      <g transform={mirror ? 'translate(210,0) scale(-1,1)' : undefined}>
        {FINGERS.map((f, i) => {
          const up = raised.has(i);
          const len = 150 - f.top;
          return (
            <g key={i} transform={`rotate(${f.rot} ${f.cx} 132)`}>
              <g className="finger" style={{ transform: `translateY(${up ? 0 : PALM_TOP + 8 - f.top}px)` }}>
                <rect x={f.cx - f.w / 2} y={f.top} width={f.w} height={len} rx={f.w / 2} fill={up ? skin : shade} className="finger-body" />
                <rect x={f.cx - f.w / 2 + 6} y={f.top + 4} width={f.w - 12} height={14} rx={(f.w - 12) / 2} fill={nail} opacity={up ? 0.45 : 0} className="nail" />
              </g>
            </g>
          );
        })}

        {/* tucked thumb */}
        <g transform="rotate(-16 170 214)">
          <rect x="158" y="138" width="28" height="92" rx="14" fill={shade} />
          <rect x="166" y="143" width="15" height="14" rx="7" fill={nail} opacity={0.6} />
        </g>
        {/* forearm (runs past the bottom edge) */}
        <rect x="78" y="200" width="62" height="240" rx="26" fill={shade} />
        {/* back of the hand */}
        <path
          d="M43 136 C44 116 80 104 119 104 C158 104 177 114 178 134 C179 168 176 200 161 226 C151 240 141 247 129 248 L88 248 C70 244 55 228 48 200 C43 178 42 154 43 136 Z"
          fill={skin}
        />
        {/* knuckle line, only visible on folded fingers */}
        {FINGERS.map((f, i) => (
          <ellipse key={i} cx={f.cx} cy={PALM_TOP + (i === 0 ? 20 : i === 2 ? 6 : 10)} rx={f.w / 2 - 4} ry={3.2} fill={deep} opacity={raised.has(i) ? 0 : 0.28} className="knuckle" />
        ))}
        {sleeve && (
          <g>
            <rect x="64" y="262" width="90" height="180" rx="16" fill={sleeve} />
            <rect x="64" y="262" width="90" height="10" rx="5" fill="#000" opacity={0.14} />
          </g>
        )}
      </g>
    </svg>
  );
}

/* Rendered hands: the 3D model photographed from above, cached per look. */
const ready = new Map<string, string[][]>();

export function useHandSprites(skin: string, sleeve: string) {
  const key = `${skin}|${sleeve}`;
  const [sprites, setSprites] = useState<string[][] | null>(() => ready.get(key) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (ready.has(key)) return setSprites(ready.get(key)!);
    let on = true;
    import('../three/scene3d')
      .then((m) => m.handSprites(skin, sleeve))
      .then((s) => {
        ready.set(key, s);
        if (on) setSprites(s);
      })
      .catch(() => on && setFailed(true));
    return () => {
      on = false;
    };
  }, [key, skin, sleeve]);
  return { sprites, failed };
}

export function HandImage({ count, hand, skin, sleeve }: { count: number; hand: 0 | 1; skin: string; sleeve: string }) {
  const { sprites, failed } = useHandSprites(skin, sleeve);
  if (failed) return <HandSVG count={count} mirror={hand === 1} skin={skin} sleeve={sleeve} />;
  return (
    <div className={`hand-img ${sprites ? 'loaded' : ''}`}>
      {sprites?.[hand].map((src, c) => <img key={c} src={src} alt="" draggable={false} className={c === count ? 'on' : ''} />)}
    </div>
  );
}
