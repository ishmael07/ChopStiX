import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, Copy, Link2, Minus, Plus, Settings, Users, Volume2, VolumeX } from 'lucide-react';
import { Game, type GameConfig, type Remote } from './components/Game';
import { Table, type ViewMode } from './components/Table';
import { Learn } from './components/Learn';
import { useAccount } from './account/useAccount';
import { AuthSheet } from './account/AuthSheet';
import { ProfilePage } from './account/ProfilePage';
import { accountsEnabled } from './account/supabase';
import { Avatar, Chips, clockLabel, Modal, Seg, Switch, usePref } from './components/ui';
import { BOTS, botMove, type Bot as BotT } from './game/bots';
import { applyMove, DEFAULT_RULES, initialState, MODES, modeOf, other, winner, type Move, type Rules, type Side, type State } from './game/rules';
import { loadProfile, saveProfile, SKINS, type Profile } from './game/profile';
import { host, join, newRoomCode, type Link, type NetMsg } from './net/online';
import { isMuted, setMuted, sfx } from './sound';

type Screen = 'lobby' | 'game' | 'learn' | 'profile';
type Opp = 'bot' | 'friend' | 'local';

const CLOCKS = [
  { value: 0, label: 'None' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 180, label: '3m' },
];
const PRESETS = CLOCKS.map((c) => c.value);
const CLOCK_STEPS = [15, 30, 45, 60, 90, 120, 180, 300, 420, 600, 900, 1200, 1800];

export default function App() {
  const [profile, setProfileState] = useState<Profile>(loadProfile);
  const setProfile = (p: Profile) => (setProfileState(p), saveProfile(p));
  const account = useAccount();
  const ap = account.profile;
  // Who "you" are: your account when signed in, otherwise the guest profile on this device.
  const me: Profile = ap ? { ...profile, name: ap.display_name, rating: ap.rating, skin: ap.skin, wins: ap.wins, losses: ap.losses, draws: ap.draws, onboarded: true } : profile;
  const meRef = useRef({ me, uid: account.session?.user.id });
  meRef.current = { me, uid: account.session?.user.id };
  const [authSheet, setAuthSheet] = useState<null | 'signin' | 'signup'>(null);
  const [screen, setScreenState] = useState<Screen>(() => (location.hash.startsWith('#/@') ? 'profile' : 'lobby'));
  const [profileUser, setProfileUser] = useState(() => decodeURIComponent(location.hash.slice(3)));
  const setScreen = (sc: Screen) => {
    setScreenState(sc);
    if (sc !== 'profile' && location.hash) history.replaceState(null, '', location.pathname + location.search);
  };
  const openProfile = (u: string) => {
    location.hash = `/@${u}`;
  };
  useEffect(() => {
    const onHash = () => {
      if (location.hash.startsWith('#/@')) {
        setProfileUser(decodeURIComponent(location.hash.slice(3)));
        setScreenState('profile');
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [opp, setOpp] = useState<Opp>(() => (new URLSearchParams(location.search).get('room') ? 'friend' : 'bot'));
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [gameKey, setGameKey] = useState(0);
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [clock, setClock] = useState(0);
  const [bot, setBot] = useState<BotT>(BOTS[1]);
  const [side, setSide] = useState<'first' | 'random' | 'second'>('first');
  const [muted, setMute] = useState(isMuted());
  const [sheet, setSheet] = useState<null | 'settings'>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customClock, setCustomClock] = useState(false);
  const [view, setView] = usePref<ViewMode>('chopstix.view', '2d');

  const start = (c: GameConfig) => {
    sfx('start');
    setConfig(c);
    setGameKey((k) => k + 1);
    setScreen('game');
  };
  const pickSide = (): Side => (side === 'first' ? 0 : side === 'second' ? 1 : Math.random() < 0.5 ? 0 : 1);

  // ---------- online ----------
  const linkRef = useRef<Link | null>(null);
  const listeners = useRef(new Set<(m: NetMsg) => void>());
  const [net, setNet] = useState<{
    role: 'host' | 'guest' | null;
    code: string;
    status: 'idle' | 'waiting' | 'connected' | 'closed' | 'error';
    error?: string;
    oppName: string;
    oppRating: number;
    oppSkin?: number;
    oppUid?: string;
    named?: boolean; // friend's hello has arrived
  }>({ role: null, code: '', status: 'idle', oppName: 'Friend', oppRating: 800 });
  const netRef = useRef(net);
  netRef.current = net;
  const accountCfg = useRef<GameConfig['account']>(undefined);
  accountCfg.current = ap ? { onRated: () => void account.refresh() } : undefined;
  const lobbyCfg = useRef({ rules, clock });
  lobbyCfg.current = { rules, clock };

  const remote: Remote | undefined = useMemo(
    () =>
      net.role
        ? {
            send: (m) => linkRef.current?.send(m),
            subscribe: (fn) => {
              listeners.current.add(fn);
              return () => void listeners.current.delete(fn);
            },
            oppName: net.oppName,
            oppRating: net.oppRating,
            oppUid: net.oppUid,
            connected: net.status === 'connected',
          }
        : undefined,
    [net.role, net.oppName, net.oppRating, net.oppUid, net.status],
  );
  const remoteRef = useRef(remote);
  remoteRef.current = remote;

  const sendStart = useCallback((hostSide: Side) => {
    const { rules, clock } = lobbyCfg.current;
    const game = Date.now();
    linkRef.current?.send({ t: 'start', rules, clock, hostSide, game });
    sfx('start');
    setConfig({ mode: 'online', rules, clock, mySide: hostSide, remote: remoteRef.current, gameKey: `${netRef.current.code}-${game}`, account: accountCfg.current });
    setGameKey((k) => k + 1);
    setScreen('game');
  }, []);

  const onNetMsg = useCallback((m: NetMsg) => {
    if (m.t === 'hello') setNet((n) => ({ ...n, oppName: m.name || 'Friend', oppRating: m.rating, oppSkin: m.skin, oppUid: m.uid, named: true }));
    if (m.t === 'start') {
      sfx('start');
      setRules(m.rules);
      setClock(m.clock);
      setConfig({ mode: 'online', rules: m.rules, clock: m.clock, mySide: other(m.hostSide), remote: remoteRef.current, gameKey: `${netRef.current.code}-${m.game}`, account: accountCfg.current });
      setGameKey((k) => k + 1);
      setScreen('game');
    }
    listeners.current.forEach((fn) => fn(m));
  }, []);

  const handlers = {
    open: () => {
      setNet((n) => ({ ...n, status: 'connected' }));
      const { me: p, uid } = meRef.current;
      linkRef.current?.send({ t: 'hello', name: p.name, rating: p.rating, skin: p.skin, uid });
    },
    msg: onNetMsg,
    close: () => setNet((n) => ({ ...n, status: 'closed' })),
    error: (e: string) => setNet((n) => ({ ...n, status: 'error', error: e })),
  };

  const createRoom = () => {
    linkRef.current?.close();
    const code = newRoomCode();
    setNet({ role: 'host', code, status: 'waiting', oppName: 'Friend', oppRating: 800 });
    linkRef.current = host(code, { ...handlers, ready: () => {} });
  };
  const cancelRoom = () => {
    linkRef.current?.close();
    linkRef.current = null;
    setNet((n) => ({ ...n, role: null, status: 'idle' }));
    history.replaceState(null, '', location.pathname);
  };

  useEffect(() => {
    const code = new URLSearchParams(location.search).get('room');
    if (!code) return;
    setNet({ role: 'guest', code, status: 'waiting', oppName: 'Friend', oppRating: 800 });
    linkRef.current = join(code, handlers);
    return () => linkRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setConfig((c) => (c && c.mode === 'online' ? { ...c, remote } : c));
  }, [remote]);

  const leaveGame = () => {
    if (config?.mode === 'online') cancelRoom();
    setScreen('lobby');
    setConfig(null);
  };

  const rematch = () => {
    if (!config) return;
    if (config.mode === 'online') {
      if (netRef.current.role === 'host') sendStart(other(config.mySide));
      return;
    }
    start({ ...config, mySide: config.mode === 'bot' ? other(config.mySide) : 0 });
  };

  const go = () => {
    if (opp === 'bot') start({ mode: 'bot', rules, clock, mySide: pickSide(), bot, account: accountCfg.current });
    else if (opp === 'local') start({ mode: 'local', rules, clock, mySide: 0 });
    else if (net.status === 'connected' && net.role === 'host') sendStart(pickSide());
    else if (net.role === 'host' && net.status === 'waiting') return;
    else createRoom();
  };

  const shareUrl = `${location.origin}${location.pathname}?room=${net.code}`;
  const [copied, setCopied] = useState(false);
  const mode = modeOf(rules);
  const hosting = opp === 'friend' && net.role === 'host';
  const stepIdx = Math.max(0, CLOCK_STEPS.findIndex((c) => c >= clock));

  if (account.loading) return null;
  if (!profile.onboarded && !account.session)
    return (
      <Welcome
        skin={profile.skin}
        onDone={(name, skin) => {
          sfx('start');
          setProfile({ ...profile, name, skin, onboarded: true });
          // an invited friend may already be connected: tell the host our real name
          linkRef.current?.send({ t: 'hello', name, rating: profile.rating, skin });
        }}
        onAccount={accountsEnabled ? () => setAuthSheet('signin') : undefined}
        authSheet={authSheet && <AuthSheet initial={authSheet} onClose={() => setAuthSheet(null)} />}
      />
    );

  return (
    <div className="app">
      <header className="topbar">
        <button className="wordmark" onClick={() => (screen === 'game' ? leaveGame() : setScreen('lobby'))} aria-label="ChopStiX home">
          ChopSti<em>X</em>
        </button>
        <nav className="topnav">
          <button className={screen !== 'learn' ? 'on' : ''} onClick={() => screen === 'learn' && setScreen(config ? 'game' : 'lobby')}>
            Play
          </button>
          <button className={screen === 'learn' ? 'on' : ''} onClick={() => setScreen('learn')}>
            Learn
          </button>
        </nav>
        <div className="top-right">
          {ap ? (
            <button className="me-chip" onClick={() => openProfile(ap.username)} title="Your profile">
              <Avatar name={ap.display_name} color={SKINS[ap.skin]} size={26} />
              <span>{ap.display_name}</span>
              <b>{ap.rating}</b>
            </button>
          ) : (
            <>
              <span className="rating-pill" title="Your rating on this device">
                {profile.rating}
              </span>
              {accountsEnabled && (
                <button className="btn small" onClick={() => setAuthSheet('signup')}>
                  Sign up
                </button>
              )}
            </>
          )}
          <button
            className="icon-btn"
            aria-label={muted ? 'Unmute' : 'Mute'}
            onClick={() => {
              setMuted(!muted);
              setMute(!muted);
            }}
          >
            {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
          </button>
          <button className="icon-btn" aria-label="Settings" onClick={() => setSheet('settings')}>
            <Settings size={19} />
          </button>
        </div>
      </header>

      <main className="main">
        {screen === 'game' && config && (
          <Game key={gameKey} config={config} profile={me} setProfile={ap ? () => {} : setProfile} onRematch={rematch} onExit={leaveGame} />
        )}

        {screen === 'lobby' && (
          <div className="lobby screen">
            <div className="lobby-board">
              <DemoTable view={view} skin={SKINS[me.skin]} />
            </div>

            <section className="play-card">
              <Seg
                value={opp}
                onChange={setOpp}
                options={[
                  { value: 'bot', label: <span className="seg-ico"><Bot size={17} /> Computer</span> },
                  { value: 'friend', label: <span className="seg-ico"><Link2 size={17} /> Friend</span> },
                  { value: 'local', label: <span className="seg-ico"><Users size={17} /> Local</span> },
                ]}
              />

              {opp === 'bot' && (
                <div className="bot-pick">
                  <div className="bot-hero" key={bot.id}>
                    <Avatar name={bot.name} color={bot.color} size={56} />
                    <div>
                      <div className="bot-name">
                        {bot.name} <span>{bot.rating}</span>
                      </div>
                      <div className="bot-sub">{bot.blurb}</div>
                    </div>
                  </div>
                  <div className="steps" role="radiogroup" aria-label="Difficulty">
                    {BOTS.map((b, i) => (
                      <button
                        key={b.id}
                        role="radio"
                        aria-checked={b.id === bot.id}
                        aria-label={`${b.name}, ${b.rating}`}
                        className={`step ${BOTS.indexOf(bot) >= i ? 'fill' : ''} ${b.id === bot.id ? 'on' : ''}`}
                        onClick={() => setBot(b)}
                      />
                    ))}
                  </div>
                  <div className="steps-labels">
                    <span>Easier</span>
                    <span>Harder</span>
                  </div>
                </div>
              )}
              {opp === 'friend' && net.role !== 'guest' && !hosting && <p className="card-note">Get a link to send. You play live as soon as they open it.</p>}
              {opp === 'local' && <p className="card-note">Two players, one screen. Take turns.</p>}

              {opp === 'friend' && net.role === 'guest' ? (
                <div className="invite">
                  <Lobby
                    left={net.status === 'connected' && net.named ? { name: net.oppName, rating: net.oppRating, color: SKINS[net.oppSkin ?? 3], host: true } : null}
                    right={{ name: me.name, rating: me.rating, color: SKINS[me.skin], you: true }}
                  />
                  {(net.status === 'error' || net.status === 'closed') ? (
                    <div className="notice warn">{net.error ?? 'Your friend closed the invite.'}</div>
                  ) : (
                    <p className="lobby-status">{net.status === 'connected' ? `Waiting for ${net.oppName} to start` : 'Joining…'}</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="opts">
                    <Chips
                      label="Rules"
                      value={customOpen ? 'custom' : mode}
                      onChange={(m) => (m === 'custom' ? setCustomOpen(true) : (setRules(MODES[m].rules), setCustomOpen(false)))}
                      options={[
                        { value: 'classic', label: 'Classic' },
                        { value: 'street', label: 'Lunch Table' },
                        { value: 'custom', label: 'Custom' },
                      ]}
                    />
                    {(customOpen || mode === 'custom') && (
                      <div className="custom-inline">
                        <Switch label="Splits" on={rules.splits} onChange={(v) => setRules({ ...rules, splits: v })} />
                        <Switch label="Revive dead hands" on={rules.revive} disabled={!rules.splits} onChange={(v) => setRules({ ...rules, revive: v })} />
                        <Switch label="Flip 3-1 → 1-3" on={rules.mirror} disabled={!rules.splits} onChange={(v) => setRules({ ...rules, mirror: v })} />
                        <Switch label="Empty a hand" on={rules.suicide} disabled={!rules.splits} onChange={(v) => setRules({ ...rules, suicide: v })} />
                        <Switch label="Tap your own hand" on={rules.selfTap} onChange={(v) => setRules({ ...rules, selfTap: v })} />
                      </div>
                    )}
                    <Chips
                      label="Clock"
                      value={customClock ? -1 : clock}
                      onChange={(v) => {
                        if (v === -1) {
                          setCustomClock(true);
                          if (PRESETS.includes(clock)) setClock(300);
                        } else (setCustomClock(false), setClock(v));
                      }}
                      options={[
                        ...CLOCKS,
                        { value: -1, title: 'Custom time', label: customClock ? clockLabel(clock) : <Plus size={16} aria-label="Custom time" /> },
                      ]}
                    />
                    {customClock && (
                      <div className="stepper" role="group" aria-label="Custom time per player">
                        <button className="round" onClick={() => setClock(CLOCK_STEPS[Math.max(0, stepIdx - 1)])} disabled={stepIdx === 0} aria-label="Less time">
                          <Minus size={16} />
                        </button>
                        <div className="stepper-value">
                          <b>{clockLabel(clock)}</b>
                          <span>per player</span>
                        </div>
                        <button className="round" onClick={() => setClock(CLOCK_STEPS[Math.min(CLOCK_STEPS.length - 1, stepIdx + 1)])} disabled={stepIdx === CLOCK_STEPS.length - 1} aria-label="More time">
                          <Plus size={16} />
                        </button>
                      </div>
                    )}
                    {opp !== 'local' && (
                      <Chips
                        label="First"
                        value={side}
                        onChange={setSide}
                        options={[
                          { value: 'first', label: 'Me' },
                          { value: 'random', label: 'Random' },
                          { value: 'second', label: 'Them' },
                        ]}
                      />
                    )}
                  </div>

                  {hosting && (
                    <div className="invite">
                      <Lobby
                        left={{ name: me.name, rating: me.rating, color: SKINS[me.skin], you: true }}
                        right={net.status === 'connected' ? { name: net.named ? net.oppName : 'Joining…', rating: net.named ? net.oppRating : null, color: SKINS[net.oppSkin ?? 3] } : null}
                      />
                      <div className="share">
                        <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} aria-label="Invite link" />
                        <button
                          className={`icon-btn solid ${copied ? 'ok' : ''}`}
                          aria-label="Copy link"
                          onClick={() => {
                            navigator.clipboard?.writeText(shareUrl);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          }}
                        >
                          {copied ? <Check size={18} /> : <Copy size={18} />}
                        </button>
                      </div>
                      {net.status === 'closed' && <div className="notice warn">Your friend left. Create a new link to invite someone else.</div>}
                      {net.status === 'error' && <div className="notice warn">{net.error}</div>}
                    </div>
                  )}

                  <button className="btn primary play-btn" onClick={go} disabled={hosting && net.status === 'waiting'}>
                    {opp === 'friend' ? (net.role === 'host' ? (net.status === 'connected' ? 'Start game' : net.status === 'closed' || net.status === 'error' ? 'Create new link' : 'Waiting for friend…') : 'Create invite link') : 'Play'}
                  </button>
                  {hosting && (
                    <button className="link-btn center" onClick={cancelRoom}>
                      Cancel invite
                    </button>
                  )}
                </>
              )}
            </section>
          </div>
        )}

        {screen === 'learn' && <Learn skin={SKINS[me.skin]} onPlay={() => setScreen('lobby')} />}
        {screen === 'profile' && (accountsEnabled ? <ProfilePage username={profileUser} account={account} onOpen={openProfile} /> : <div className="screen"><h1>Profiles need accounts, which aren't switched on yet.</h1></div>)}
      </main>

      {sheet === 'settings' && (
        <Modal onClose={() => setSheet(null)}>
          <h2>Settings</h2>
          {ap ? (
            <div className="account-row">
              <Avatar name={ap.display_name} color={SKINS[ap.skin]} size={40} />
              <div>
                <b>{ap.display_name}</b>
                <span className="muted">@{ap.username}</span>
              </div>
              <button className="btn small" onClick={() => (setSheet(null), openProfile(ap.username))}>
                Profile
              </button>
            </div>
          ) : (
            <>
              <div className="field">
                <label>Name</label>
                <input className="text" value={profile.name} maxLength={18} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
              </div>
              <div className="field">
                <label>Hands</label>
                <div className="skins">
                  {SKINS.map((sk, i) => (
                    <button key={sk} className={`skin ${profile.skin === i ? 'on' : ''}`} style={{ background: sk }} onClick={() => setProfile({ ...profile, skin: i })} aria-label={`Skin tone ${i + 1}`} />
                  ))}
                </div>
              </div>
            </>
          )}
          <div className="field">
            <label>Board</label>
            <Seg
              value={view}
              onChange={setView}
              options={[
                { value: '2d', label: '2D' },
                { value: '3d', label: '3D' },
              ]}
            />
          </div>
          {ap ? (
            <button className="link-btn danger" onClick={() => (setSheet(null), void account.signOut())}>
              Log out
            </button>
          ) : accountsEnabled ? (
            <div className="guest-cta">
              <p className="muted">You're playing as a guest. Your rating is saved on this device only.</p>
              <button className="btn primary" onClick={() => (setSheet(null), setAuthSheet('signup'))}>
                Create an account
              </button>
              <button className="link-btn center" onClick={() => (setSheet(null), setAuthSheet('signin'))}>
                I already have one
              </button>
            </div>
          ) : (
            <button className="link-btn danger" onClick={() => setProfile({ ...profile, rating: 800, wins: 0, losses: 0, draws: 0, history: [] })}>
              Reset rating and stats
            </button>
          )}
        </Modal>
      )}

      {authSheet && <AuthSheet initial={authSheet} defaultName={profile.onboarded ? profile.name : ''} onClose={() => setAuthSheet(null)} />}
    </div>
  );
}


/** Two bots quietly playing on the home screen. */
function DemoTable({ view, skin }: { view: ViewMode; skin: string }) {
  const [hist, setHist] = useState<{ state: State; move: Move | null }[]>([{ state: initialState(), move: null }]);
  useEffect(() => {
    const id = window.setInterval(() => {
      setHist((h) => {
        const cur = h[h.length - 1].state;
        if (winner(cur) !== null || h.length > 24) return [{ state: initialState(), move: null }];
        const m = botMove(BOTS[2], DEFAULT_RULES, cur);
        return [...h, { state: applyMove(DEFAULT_RULES, cur, m), move: m }];
      });
    }, 1700);
    return () => window.clearInterval(id);
  }, []);
  const last = hist[hist.length - 1];
  return (
    <Table
      demo
      state={last.state}
      rules={DEFAULT_RULES}
      bottom={0}
      canAct={false}
      lastMove={last.move}
      ply={hist.length - 1}
      skins={[skin, SKINS[3]]}
      sleeves={['#ecebe6', '#2b2b2e']}
      view={view}
      onView={() => {}}
      onMove={() => {}}
    />
  );
}

function Welcome({ skin: initialSkin, onDone, onAccount, authSheet }: { skin: number; onDone: (name: string, skin: number) => void; onAccount?: () => void; authSheet?: ReactNode }) {
  const [name, setName] = useState('');
  const [skin, setSkin] = useState(initialSkin);
  const clean = name.trim().replace(/\s+/g, ' ');
  const invited = new URLSearchParams(location.search).has('room');
  return (
    <div className="welcome">
      <div className="welcome-board">
        <DemoTable view="2d" skin={SKINS[skin]} />
      </div>
      <form
        className="welcome-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (clean) onDone(clean, skin);
        }}
      >
        <div className="welcome-mark">
          ChopSti<em>X</em>
        </div>
        <h1 className="welcome-h">{invited ? 'You’ve been invited to a game.' : 'The finger game, played properly.'}</h1>
        <p className="welcome-sub">{invited ? 'Pick a name and you’re in.' : 'Play bots, friends, or the person next to you.'}</p>

        <div className="welcome-fields">
          <label className="wf">
            <span>Name</span>
            <input id="name" className="text big" autoFocus autoComplete="nickname" maxLength={18} placeholder="What should we call you?" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="wf">
            <span>Hands</span>
            <div className="tones" role="radiogroup" aria-label="Hand tone">
              {SKINS.map((s, i) => (
                <button type="button" key={s} role="radio" aria-checked={skin === i} className={`tone ${skin === i ? 'on' : ''}`} style={{ background: s }} onClick={() => setSkin(i)} aria-label={`Hand tone ${i + 1}`} />
              ))}
            </div>
          </div>
        </div>

        <button className="btn primary play-btn" disabled={!clean}>
          {invited ? 'Join game' : 'Start playing'}
        </button>
        <div className="welcome-foot">
          <span>No account needed. Saved on this device.</span>
          {onAccount && (
            <button type="button" className="link-btn" onClick={onAccount}>
              Log in
            </button>
          )}
        </div>
      </form>
      {authSheet}
    </div>
  );
}

type LobbySeat = { name: string; rating: number | null; color: string; you?: boolean; host?: boolean } | null;

/** Two seats facing off. An empty seat pulses until someone sits down. */
function Lobby({ left, right }: { left: LobbySeat; right: LobbySeat }) {
  const seat = (p: LobbySeat, k: string) =>
    p ? (
      <div className="seat in" key={`${k}-${p.name}`}>
        <Avatar name={p.name} color={p.color} size={60} />
        <b>{p.name}</b>
        <span>{p.you ? 'You' : p.host ? 'Host' : p.rating ?? ''}</span>
      </div>
    ) : (
      <div className="seat empty" key={`${k}-empty`}>
        <span className="seat-ring" />
        <b>Waiting…</b>
        <span>&nbsp;</span>
      </div>
    );
  return (
    <div className="lobby-seats">
      {seat(left, 'l')}
      <span className={`seat-vs ${left && right ? 'ready' : ''}`}>vs</span>
      {seat(right, 'r')}
    </div>
  );
}
