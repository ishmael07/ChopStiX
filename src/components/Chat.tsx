import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Volume2, VolumeX } from 'lucide-react';
import { QUICK_PHRASES } from '../game/chat';

export interface ChatLine {
  id: string | number;
  mine: boolean;
  body: string;
}

/** Chat under the move list. Muting hides the other player's messages on this screen only. */
export function Chat({ lines, oppName, onSend, error }: { lines: ChatLine[]; oppName: string; onSend: (text: string) => void; error?: string | null }) {
  const [text, setText] = useState('');
  const [muted, setMuted] = useState(false);
  const [open, setOpen] = useState(true);
  const [seen, setSeen] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = muted ? lines.filter((l) => l.mine) : lines;
  const unread = open ? 0 : shown.length - seen;

  useEffect(() => {
    if (open) setSeen(shown.length);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [open, shown.length]);

  const send = (t: string) => {
    const clean = t.trim();
    if (!clean) return;
    onSend(clean);
    setText('');
  };

  return (
    <section className={`chat ${open ? 'open' : ''}`}>
      <header className="chat-head">
        <button className="chat-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <MessageCircle size={16} /> Chat
          {unread > 0 && <span className="chat-unread">{unread}</span>}
        </button>
        {open && (
          <button className="icon-btn sm" onClick={() => setMuted((m) => !m)} title={muted ? `Show ${oppName}'s messages` : `Mute ${oppName}`} aria-label={muted ? `Unmute ${oppName}` : `Mute ${oppName}`}>
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
        )}
      </header>
      {open && (
        <>
          <div className="chat-list" ref={listRef} aria-live="polite">
            {shown.length === 0 && <p className="chat-empty">{muted ? `${oppName} is muted.` : 'Say hi. Keep it friendly.'}</p>}
            {shown.map((l) => (
              <div key={l.id} className={`chat-line ${l.mine ? 'mine' : ''}`}>
                <b>{l.mine ? 'You' : oppName}</b> {l.body}
              </div>
            ))}
          </div>
          <div className="chat-quick">
            {QUICK_PHRASES.map((q) => (
              <button key={q} onClick={() => send(q)}>
                {q}
              </button>
            ))}
          </div>
          {error && <div className="chat-error">{error}</div>}
          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <input className="text" value={text} maxLength={140} placeholder="Message" onChange={(e) => setText(e.target.value)} aria-label="Chat message" />
            <button className="icon-btn solid" aria-label="Send" disabled={!text.trim()}>
              <Send size={16} />
            </button>
          </form>
        </>
      )}
    </section>
  );
}
