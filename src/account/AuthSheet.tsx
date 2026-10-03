import { useState } from 'react';
import { Modal, Seg } from '../components/ui';
import { supabase } from './supabase';

type Tab = 'signin' | 'signup';
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

export function AuthSheet({ onClose, initial = 'signup', defaultName = '' }: { onClose: () => void; initial?: Tab; defaultName?: string }) {
  const [tab, setTab] = useState<Tab>(initial);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState(defaultName.replace(/[^A-Za-z0-9_]/g, '').slice(0, 20));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setError(null);
    setBusy(true);
    try {
      if (tab === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return setError(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
        return onClose();
      }
      if (!USERNAME.test(username)) return setError('Usernames are 3 to 20 letters, numbers or underscores.');
      if (password.length < 8) return setError('Use at least 8 characters for your password.');
      const { data: free } = await supabase.rpc('username_available', { p_username: username });
      if (!free) return setError('That username is taken.');
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { username, display_name: username }, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) return setError(error.message);
      if (data.session) return onClose(); // email confirmation is off
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <Modal onClose={onClose}>
        <h2>Check your email</h2>
        <p className="muted">
          We sent a confirmation link to <b className="em">{email}</b>. Open it on this device and you&apos;re in.
        </p>
        <button className="btn primary" onClick={onClose}>
          Got it
        </button>
      </Modal>
    );

  return (
    <Modal onClose={onClose}>
      <h2>{tab === 'signup' ? 'Create your account' : 'Welcome back'}</h2>
      <Seg
        value={tab}
        onChange={(t) => (setTab(t), setError(null))}
        options={[
          { value: 'signup', label: 'Sign up' },
          { value: 'signin', label: 'Log in' },
        ]}
      />
      <form className="auth-form" onSubmit={submit}>
        {tab === 'signup' && (
          <label>
            <span>Username</span>
            <input className="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="lunchtable_legend" maxLength={20} required />
          </label>
        )}
        <label>
          <span>Email</span>
          <input className="text" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          <span>Password</span>
          <input className="text" type="password" autoComplete={tab === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="notice warn">{error}</div>}
        <button className="btn primary play-btn" disabled={busy}>
          {busy ? '…' : tab === 'signup' ? 'Create account' : 'Log in'}
        </button>
      </form>
      {tab === 'signup' && <p className="auth-note">Your rating and games are saved to your account, on any device.</p>}
    </Modal>
  );
}
