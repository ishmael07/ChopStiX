import { useState } from 'react';
import { loginEmail, supabase } from './supabase';

/** Settings row: check the current password, then set a new one. */
export function ChangePassword({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!open)
    return (
      <button className="link-btn" onClick={() => setOpen(true)}>
        Change password
      </button>
    );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    if (next.length < 8) return setMsg({ ok: false, text: 'Use at least 8 characters.' });
    setBusy(true);
    setMsg(null);
    try {
      // Supabase lets a signed-in user set a new password without the old one, so check it first.
      const { data: u } = await supabase.auth.getUser();
      const { error: wrong } = await supabase.auth.signInWithPassword({ email: u.user?.email ?? loginEmail(username), password: current });
      if (wrong) return setMsg({ ok: false, text: 'Your current password is wrong.' });
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) return setMsg({ ok: false, text: error.message });
      setMsg({ ok: true, text: 'Password changed.' });
      setCurrent('');
      setNext('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={save}>
      <label>
        <span>Current password</span>
        <input className="text" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label>
        <span>New password</span>
        <input className="text" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </label>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'warn'}`}>{msg.text}</div>}
      <button className="btn" disabled={busy}>
        {busy ? '…' : 'Save new password'}
      </button>
    </form>
  );
}
