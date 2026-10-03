import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Avatar({ name, color, size = 40 }: { name: string; color: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  size,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  size?: 'lg' | 'mini';
}) {
  const i = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className={`seg ${size ?? ''}`} style={{ ['--n' as string]: options.length, ['--i' as string]: i }}>
      <span className="seg-thumb" />
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ onClose, children, className }: { onClose: () => void; children: ReactNode; className?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className={`modal ${className ?? ''}`} onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button className={`switch-row ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span>{label}</span>
      <span className="switch" />
    </button>
  );
}

/** A tiny persisted preference (per browser). */
export function usePref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const set = (x: T) => {
    setV(x);
    try {
      localStorage.setItem(key, x);
    } catch {
      /* ignore */
    }
  };
  return [v, set];
}

/** A labeled row of options sized to their text, with a sliding highlight. */
export function Chips<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
}) {
  const set = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const i = options.findIndex((o) => o.value === value);
  useLayoutEffect(() => {
    const measure = () => {
      const el = set.current?.querySelectorAll<HTMLButtonElement>('.pill')[i];
      setThumb(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (set.current) ro.observe(set.current);
    return () => ro.disconnect();
  }, [i, options.length, value]);
  return (
    <div className="chips-row" role="radiogroup" aria-label={label}>
      <span className="chips-label">{label}</span>
      <div className="chips-set" ref={set}>
        {thumb && <span className="chips-thumb" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} />}
        {options.map((o) => (
          <button key={String(o.value)} role="radio" title={o.title} aria-checked={o.value === value} className={`pill ${o.value === value ? 'on' : ''}`} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 45 -> "45s", 300 -> "5m", 90 -> "1m 30s" */
export function clockLabel(sec: number) {
  if (sec < 60) return `${sec}s`;
  return sec % 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec / 60}m`;
}
