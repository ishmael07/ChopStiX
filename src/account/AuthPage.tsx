import { useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Seg } from '../components/ui';
import { SKINS } from '../game/profile';
import { accountsEnabled, loginEmail, supabase } from './supabase';

export type AuthTab = 'signup' | 'login' | 'guest';
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

/** Sign up, log in, or carry on as a guest. Used as the first screen and from the top bar. */
export function AuthPage({
  initial,
  board,
  guestSkin,
  invited,
  onGuest,
  onBack,
}: {
  initial: AuthTab;
  board: ReactNode;
  guestSkin: number;
  invited?: boolean;
  /** Present on first visit: play without an account. */
  onGuest?: (name: string, skin: number) => void;
  /** Present when opened from inside the app. */
  onBack?: () => void;
}) {
  const [tab, setTab] = useState<AuthTab>(initial);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [skin, setSkin] = useState(guestSkin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = (t: AuthTab) => (setTab(t), setError(null));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (tab === 'guest') {
      const clean = name.trim().replace(/\s+/g, ' ');
      return clean && onGuest?.(clean, skin);
    }
    if (!supabase) return;
    setBusy(true);
    try {
      if (tab === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email: loginEmail(username), password });
        if (error) setError(error.message === 'Invalid login credentials' ? 'Wrong username or password.' : error.message);
        return; // on success the app switches screens by itself
      }
      if (!USERNAME.test(username)) return setError('Usernames are 3 to 20 letters, numbers or underscores.');
      if (password.length < 8) return setError('Use at least 8 characters for your password.');
      if (password !== confirm) return setError("The two passwords don't match.");
      const { data: free } = await supabase.rpc('username_available', { p_username: username });
      if (!free) return setError('That username is taken.');
      const { data, error } = await supabase.auth.signUp({
        email: loginEmail(username),
        password,
        options: { data: { username, display_name: username, skin } },
      });
      if (error) return setError(/registered|exists/i.test(error.message) ? 'That username is taken.' : error.message);
      if (!data.session) setError('Your account was created but needs confirming. Ask the site owner to turn off email confirmation in Supabase.');
    } finally {
      setBusy(false);
    }
  }

  const heading = invited
    ? 'You’ve been invited to a game.'
    : tab === 'login'
      ? 'Welcome back.'
      : tab === 'guest'
        ? 'Play as a guest.'
        : 'The finger game, played properly.';
  const sub =
    tab === 'signup'
      ? 'Make an account to keep your rating, games and profile on any device.'
      : tab === 'login'
        ? 'Log in with your username and password.'
        : 'Pick a name. Your rating stays on this device only.';

  return (
    <div className="welcome">
      <div className="welcome-board">{board}</div>
      <form className="welcome-form" onSubmit={submit}>
        {onBack ? (
          <button type="button" className="link-btn back-link" onClick={onBack}>
            <ArrowLeft size={16} /> Back
          </button>
        ) : (
          <div className="welcome-mark">
            ChopSti<em>X</em>
          </div>
        )}
        <h1 className="welcome-h">{heading}</h1>
        <p className="welcome-sub">{sub}</p>

        {tab !== 'guest' && (
          <Seg
            value={tab}
            onChange={go}
            options={[
              { value: 'signup', label: 'Sign up' },
              { value: 'login', label: 'Log in' },
            ]}
          />
        )}

        <div className="welcome-fields auth-fields" key={tab}>
          {tab === 'guest' ? (
            <label className="wf">
              <span>Name</span>
              <input className="text big" autoFocus autoComplete="nickname" maxLength={18} placeholder="What should we call you?" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          ) : (
            <>
              <label className="wf">
                <span>{tab === 'login' ? 'Username' : 'Choose a username'}</span>
                <input
                  className="text big"
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={tab === 'login' ? 120 : 20}
                  placeholder={tab === 'signup' ? 'lunchtable_legend' : ''}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </label>
              <label className="wf">
                <span>Password</span>
                <input className="text big" type="password" autoComplete={tab === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
              {tab === 'signup' && (
                <label className="wf">
                  <span>Confirm password</span>
                  <input className="text big" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
                </label>
              )}
            </>
          )}
          {tab !== 'login' && (
            <div className="wf">
              <span>Hands</span>
              <div className="tones" role="radiogroup" aria-label="Hand tone">
                {SKINS.map((s, i) => (
                  <button type="button" key={s} role="radio" aria-checked={skin === i} className={`tone ${skin === i ? 'on' : ''}`} style={{ background: s }} onClick={() => setSkin(i)} aria-label={`Hand tone ${i + 1}`} />
                ))}
              </div>
            </div>
          )}
          {error && <div className="notice warn">{error}</div>}
        </div>

        <button className="btn primary play-btn" disabled={busy || (tab === 'guest' && !name.trim())}>
          {busy ? '…' : tab === 'signup' ? 'Create account' : tab === 'login' ? 'Log in' : invited ? 'Join game' : 'Start playing'}
        </button>

        <div className="welcome-foot">
          {tab === 'guest' ? (
            accountsEnabled && <>
              <span>Want to keep your rating?</span>
              <button type="button" className="link-btn" onClick={() => go('signup')}>
                Create an account
              </button>
            </>
          ) : onGuest ? (
            <>
              <span>{tab === 'signup' ? 'Just want to play?' : 'No account?'}</span>
              <button type="button" className="link-btn" onClick={() => go('guest')}>
                Play as guest
              </button>
            </>
          ) : (
            <span>{tab === 'signup' ? 'Usernames can’t be changed later. Your display name can.' : 'Your guest rating stays on this device.'}</span>
          )}
        </div>
      </form>
    </div>
  );
}
