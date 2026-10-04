import { useCallback, useEffect, useState } from 'react';
import { Check, Swords, UserPlus, X } from 'lucide-react';
import { Avatar, Chips, clockLabel, Modal } from '../components/ui';
import { SKINS } from '../game/profile';
import { QUICK_CLOCKS, type QuickMode } from '../net/match';
import { friendRemove, friendRequest, friendsList, type Friend, type PlayerCard } from '../net/social';
import { supabase } from './supabase';

export type ChallengeFn = (who: PlayerCard, mode: QuickMode, clock: number) => void;

/** Pick rules and clock, then send. */
export function ChallengePicker({ who, onSend, onClose }: { who: PlayerCard; onSend: ChallengeFn; onClose: () => void }) {
  const [mode, setMode] = useState<QuickMode>('classic');
  const [clock, setClock] = useState(60);
  return (
    <div className="challenge-pick">
      <Chips
        label="Rules"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'classic', label: 'Classic' },
          { value: 'street', label: 'Lunch Table' },
        ]}
      />
      <Chips label="Clock" value={clock} onChange={setClock} options={QUICK_CLOCKS.map((c) => ({ value: c as number, label: clockLabel(c) }))} />
      <div className="challenge-actions">
        <button className="btn primary" onClick={() => (onSend(who, mode, clock), onClose())}>
          <Swords size={16} /> Challenge {who.display_name}
        </button>
        <button className="link-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function FriendsSheet({ onClose, onOpen, onChallenge, onChange }: { onClose: () => void; onOpen: (username: string) => void; onChallenge: ChallengeFn; onChange: () => void }) {
  const [list, setList] = useState<Friend[] | null>(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  const reload = useCallback(() => {
    friendsList().then(setList, (e: Error) => setMsg({ ok: false, text: e.message }));
    onChange();
  }, [onChange]);
  useEffect(() => {
    friendsList().then(setList, (e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const u = name.trim().replace(/^@/, '');
    if (!u) return;
    const { data } = await supabase!.from('profiles').select('id, display_name').ilike('username', u.replace(/[%_\\]/g, '\\$&')).maybeSingle();
    if (!data) return setMsg({ ok: false, text: `No player called @${u}.` });
    try {
      const r = await friendRequest(data.id);
      setMsg({ ok: true, text: r === 'friends' ? `You and ${data.display_name} are now friends.` : `Friend request sent to ${data.display_name}.` });
      setName('');
      reload();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  }

  const act = (p: Promise<unknown>) => p.then(reload, (e: Error) => setMsg({ ok: false, text: e.message }));
  const group = (status: Friend['status']) => list?.filter((f) => f.status === status) ?? [];
  const row = (f: Friend) => (
    <div className="friend" key={f.id}>
      <button className="friend-who" onClick={() => (onClose(), onOpen(f.username))}>
        <span className="avatar-wrap">
          <Avatar name={f.display_name} color={SKINS[f.skin] ?? SKINS[1]} size={36} />
          {f.status === 'friends' && <i className={`online-dot ${f.online ? '' : 'off'}`} title={f.online ? 'Online' : 'Offline'} />}
        </span>
        <span>
          <b>{f.display_name}</b>
          <small>
            @{f.username} · {f.rating}
          </small>
        </span>
      </button>
      {f.status === 'incoming' && (
        <>
          <button className="icon-btn solid ok" aria-label={`Accept ${f.display_name}`} onClick={() => act(friendRequest(f.id))}>
            <Check size={17} />
          </button>
          <button className="icon-btn" aria-label={`Decline ${f.display_name}`} onClick={() => act(friendRemove(f.id))}>
            <X size={17} />
          </button>
        </>
      )}
      {f.status === 'outgoing' && (
        <button className="link-btn" onClick={() => act(friendRemove(f.id))}>
          Cancel
        </button>
      )}
      {f.status === 'friends' && (
        <>
          <button className="icon-btn" aria-label={`Challenge ${f.display_name}`} title="Challenge" onClick={() => setPicking(picking === f.id ? null : f.id)}>
            <Swords size={17} />
          </button>
          <button className="icon-btn" aria-label={`Remove ${f.display_name}`} title="Remove friend" onClick={() => act(friendRemove(f.id))}>
            <X size={17} />
          </button>
        </>
      )}
      {picking === f.id && <ChallengePicker who={f} onSend={onChallenge} onClose={() => (setPicking(null), onClose())} />}
    </div>
  );

  return (
    <Modal onClose={onClose} className="friends-sheet">
      <h2>Friends</h2>
      <form className="friend-add" onSubmit={add}>
        <input className="text" placeholder="Add by username" autoCapitalize="none" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} aria-label="Username to add" />
        <button className="btn" aria-label="Send friend request">
          <UserPlus size={17} />
        </button>
      </form>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'warn'}`}>{msg.text}</div>}
      {!list && <p className="muted">Loading…</p>}
      {list && list.length === 0 && <p className="muted">No friends yet. Add someone by their username, or from their profile.</p>}
      {group('incoming').length > 0 && <h3 className="friend-h">Requests</h3>}
      {group('incoming').map(row)}
      {group('friends').length > 0 && <h3 className="friend-h">Friends</h3>}
      {group('friends').map(row)}
      {group('outgoing').length > 0 && <h3 className="friend-h">Sent</h3>}
      {group('outgoing').map(row)}
    </Modal>
  );
}
