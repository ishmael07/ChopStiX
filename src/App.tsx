import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, Copy, Flame, Globe, GraduationCap, Hand, Link2, Minus, Plus, Puzzle, Settings, Swords, Trophy, UserRound, Users, Volume2, VolumeX, X } from 'lucide-react';
import { Game, type GameConfig, type Remote } from './components/Game';
import { Table, type ViewMode } from './components/Table';
import { Learn } from './components/Learn';
import { useAccount } from './account/useAccount';
import { AuthPage, type AuthTab } from './account/AuthPage';
import { ProfilePage } from './account/ProfilePage';
import { GameViewer } from './account/GameViewer';
import { ChangePassword } from './account/ChangePassword';
import { FriendsSheet } from './account/Friends';
import { Puzzles } from './components/Puzzles';
import { Leaderboard } from './components/Leaderboard';
import { cancelChallenge, challengeFriend, dailyPuzzle, heartbeat, respondChallenge, type Challenge, type Daily, type PlayerCard } from './net/social';
import { accountsEnabled } from './account/supabase';
import { Avatar, Chips, clockLabel, Modal, Seg, Switch, usePref } from './components/ui';
import { BOTS, botMove, type Bot as BotT } from './game/bots';
import { applyMove, DEFAULT_RULES, initialState, MODES, modeOf, other, winner, type Move, type Rules, type Side, type State } from './game/rules';
import { loadProfile, saveProfile, SKINS, type Profile } from './game/profile';
import { host, join, newRoomCode, type Link, type NetMsg } from './net/online';
import { currentMatch, findMatch, getMatch, leaveQueue, openMatch, QUICK_CLOCKS, type MatchLink, type MatchRow, type QuickMode } from './net/match';
import { isMuted, setMuted, sfx } from './sound';

type Screen = 'lobby' | 'game' | 'learn' | 'profile' | 'auth' | 'replay' | 'puzzles' | 'leaderboard';
type Opp = 'quick' | 'bot' | 'friend' | 'local';

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
  const [authTab, setAuthTab] = useState<AuthTab>('signup');
  // Shareable pages live in the hash: #/@username for a profile, #/game/123 for a finished game.
  const route = () => {
    const h = location.hash;
    if (h.startsWith('#/@')) return { screen: 'profile' as const, arg: decodeURIComponent(h.slice(3)) };
    const g = /^#\/game\/(\d+)$/.exec(h);
    if (g) return { screen: 'replay' as const, arg: g[1] };
    return null;
  };
  const [screen, setScreenState] = useState<Screen>(() => route()?.screen ?? 'lobby');
  const [routeArg, setRouteArg] = useState(() => route()?.arg ?? '');
  const setScreen = (sc: Screen) => {
    setScreenState(sc);
    if (sc !== 'profile' && sc !== 'replay' && location.hash) history.replaceState(null, '', location.pathname + location.search);
  };
  const openProfile = (u: string) => {
    location.hash = `/@${u}`;
  };
  const openReplay = (id: number) => {
    location.hash = `/game/${id}`;
  };
  const openAuth = (t: AuthTab) => {
    setAuthTab(t);
    setScreen('auth');
  };
  // Signing in (or up) from the auth page lands you back in the lobby.
  useEffect(() => {
    if (account.session) setScreenState((sc) => (sc === 'auth' ? 'lobby' : sc));
  }, [account.session]);
  useEffect(() => {
    const onHash = () => {
      const r = route();
      if (r) {
        setRouteArg(r.arg);
        setScreenState(r.screen);
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
  const [chatPref, setChatPref] = usePref<'on' | 'off'>('chopstix.chat', 'on');

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

  // ---------- quick play (matched strangers, games run by the server) ----------
  const [quickModePref, setQuickMode] = usePref<QuickMode>('chopstix.quickMode', 'classic');
  const [quickClockPref, setQuickClockPref] = usePref<string>('chopstix.quickClock', '60');
  const quickMode: QuickMode = quickModePref === 'street' ? 'street' : 'classic';
  const quickClock = QUICK_CLOCKS.find((c) => String(c) === quickClockPref) ?? 60;
  const setQuickClock = (c: number) => setQuickClockPref(String(c));
  const [search, setSearch] = useState<{ since: number; error?: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [unfinished, setUnfinished] = useState<MatchRow | null>(null);
  const matchRef = useRef<MatchLink | null>(null);
  const uid = account.session?.user.id;

  const openQuick = useCallback((row: MatchRow) => {
    matchRef.current?.close();
    const link = openMatch(row, meRef.current.uid!);
    matchRef.current = link;
    setSearch(null);
    setUnfinished(null);
    // When both players ask for a rematch the server starts the next game; follow it there.
    const off = link.subscribe((r) => {
      if (!r.next_match) return;
      off();
      void getMatch(r.next_match).then(openQuick, () => {});
    });
    sfx('start');
    setConfig({ mode: 'quick', rules: row.rules, clock: row.clock, mySide: link.mySide, match: link, account: accountCfg.current });
    setGameKey((k) => k + 1);
    setScreen('game');
  }, []);

  // ---------- friends, challenges and the daily puzzle ----------
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [requests, setRequests] = useState(0);
  const [incoming, setIncoming] = useState<Challenge[]>([]);
  const [sent, setSent] = useState<{ id: string; to: string; note?: string } | null>(null);
  const [daily, setDaily] = useState<Daily | null>(null);
  const sentRef = useRef(sent);
  sentRef.current = sent;

  // Check in every few seconds while signed in: marks you online and brings challenges.
  const beat = useCallback(async () => {
    const hb = await heartbeat().catch(() => null);
    if (!hb) return;
    setRequests(hb.friend_requests);
    setIncoming(hb.challenges);
    const mine = sentRef.current;
    if (mine && !mine.note && hb.sent?.id === mine.id) {
      if (hb.sent.status === 'accepted' && hb.sent.match) {
        setSent(null);
        openQuick(hb.sent.match);
      } else if (hb.sent.status !== 'pending') setSent({ ...mine, note: hb.sent.status === 'declined' ? `${mine.to} declined.` : `${mine.to} didn't answer.` });
    }
  }, [openQuick]);
  useEffect(() => {
    if (!uid) return;
    void beat();
    const id = window.setInterval(() => void beat(), sent && !sent.note ? 2500 : 10000);
    return () => window.clearInterval(id);
  }, [uid, beat, sent]);

  const sendChallenge = (who: PlayerCard, mode: QuickMode, clock: number) =>
    challengeFriend(who.id, mode, clock).then(
      (id) => setSent({ id, to: who.display_name }),
      (e: Error) => setSent({ id: '', to: who.display_name, note: e.message }),
    );
  const answer = (c: Challenge, accept: boolean) => {
    setIncoming((xs) => xs.filter((x) => x.id !== c.id));
    respondChallenge(c.id, accept).then(
      (m) => m && openQuick(m),
      (e: Error) => setSent({ id: '', to: c.from.display_name, note: e.message }),
    );
  };

  useEffect(() => {
    if (!accountsEnabled || screen !== 'lobby') return;
    dailyPuzzle().then(setDaily, () => {});
  }, [screen, uid]);

  // After a reload or a dropped connection, offer to go back to a game that's still running.
  useEffect(() => {
    if (!uid || screen !== 'lobby') return;
    let live = true;
    currentMatch().then((r) => live && setUnfinished(r), () => {});
    return () => void (live = false);
  }, [uid, screen]);

  useEffect(() => {
    if (!search) return;
    let live = true;
    const poll = async () => {
      try {
        const res = await findMatch(quickMode, quickClock);
        if (live && res.status === 'matched') openQuick(res.match);
      } catch (e) {
        if (live) setSearch((s) => s && { ...s, error: (e as Error).message });
      }
    };
    void poll();
    const id = window.setInterval(() => (setNow(Date.now()), void poll()), 2000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      window.clearInterval(id);
      window.clearInterval(tick);
    };
    // restarting the search when the options change is intended
  }, [search?.since, quickMode, quickClock, openQuick]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelSearch = () => {
    setSearch(null);
    void leaveQueue().catch(() => {});
  };
  useEffect(() => {
    if (opp !== 'quick' && search) cancelSearch();
  }, [opp]); // eslint-disable-line react-hooks/exhaustive-deps

  const leaveGame = () => {
    if (config?.mode === 'online') cancelRoom();
    if (config?.mode === 'quick') {
      matchRef.current?.close();
      matchRef.current = null;
    }
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
    if (opp === 'quick') return search ? cancelSearch() : setSearch({ since: Date.now() });
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
  const invited = new URLSearchParams(location.search).has('room');
  if (!profile.onboarded && !account.session)
    return (
      <AuthPage
        initial={invited || !accountsEnabled ? 'guest' : 'signup'}
        invited={invited}
        board={<DemoTable view="2d" skin={SKINS[profile.skin]} />}
        guestSkin={profile.skin}
        onGuest={(name, skin) => {
          sfx('start');
          setProfile({ ...profile, name, skin, onboarded: true });
          // an invited friend may already be connected: tell the host our real name
          linkRef.current?.send({ t: 'hello', name, rating: profile.rating, skin });
        }}
      />
    );
  if (screen === 'auth' && !account.session)
    return <AuthPage key={authTab} initial={authTab} board={<DemoTable view="2d" skin={SKINS[me.skin]} />} guestSkin={profile.skin} onBack={() => setScreen(config ? 'game' : 'lobby')} />;

  return (
    <div className="app">
      <header className="topbar">
        <button className="wordmark" onClick={() => (screen === 'game' ? leaveGame() : setScreen('lobby'))} aria-label="ChopStiX home">
          ChopSti<em>X</em>
        </button>
        <nav className="topnav">
          <button className={screen === 'lobby' || screen === 'game' ? 'on' : ''} onClick={() => setScreen(config ? 'game' : 'lobby')}>
            <Hand size={17} />
            <span>Play</span>
          </button>
          {accountsEnabled && (
            <>
              <button className={screen === 'puzzles' ? 'on' : ''} onClick={() => setScreen('puzzles')}>
                <Puzzle size={17} />
                <span>Puzzles</span>
              </button>
              <button className={screen === 'leaderboard' ? 'on' : ''} onClick={() => setScreen('leaderboard')}>
                <Trophy size={17} />
                <span>Leaderboard</span>
              </button>
            </>
          )}
          <button className={screen === 'learn' ? 'on' : ''} onClick={() => setScreen('learn')}>
            <GraduationCap size={17} />
            <span>Learn</span>
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
                <>
                  <button className="link-btn top-login" onClick={() => openAuth('login')}>
                    Log in
                  </button>
                  <button className="btn small" onClick={() => openAuth('signup')}>
                    Sign up
                  </button>
                </>
              )}
            </>
          )}
          {ap && (
            <button className="icon-btn has-count" aria-label={requests ? `Friends, ${requests} new requests` : 'Friends'} onClick={() => setFriendsOpen(true)}>
              <UserRound size={19} />
              {requests > 0 && <span className="count">{requests}</span>}
            </button>
          )}
          <button
            className="icon-btn top-mute"
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
          <Game key={gameKey} config={config} profile={me} setProfile={ap ? () => {} : setProfile} onRematch={rematch} onExit={leaveGame} chatOn={chatPref === 'on'} />
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
                  ...(accountsEnabled ? [{ value: 'quick' as const, label: <span className="seg-ico"><Globe size={17} /> Online</span> }] : []),
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

              {unfinished && (
                <button className="notice resume" onClick={() => openQuick(unfinished)}>
                  You have a game in progress against <b>{(unfinished.players?.find((p) => p.id !== uid) ?? unfinished.players?.[0])?.display_name}</b>. Return to it
                </button>
              )}

              {opp === 'quick' ? (
                !ap ? (
                  <div className="guest-cta">
                    <p className="card-note">Play rated games against people around your rating. You need an account so your rating follows you.</p>
                    <button className="btn primary play-btn" onClick={() => openAuth('signup')}>
                      Create an account
                    </button>
                    <button className="link-btn center" onClick={() => openAuth('login')}>
                      I already have one
                    </button>
                  </div>
                ) : (
                  <>
                    {search ? (
                      <div className="invite">
                        <Lobby left={{ name: me.name, rating: me.rating, color: SKINS[me.skin], you: true }} right={null} />
                        <p className="lobby-status">
                          Finding an opponent near {me.rating} · {Math.floor(Math.max(0, now - search.since) / 1000)}s
                        </p>
                        {search.error && <div className="notice warn">{search.error}</div>}
                      </div>
                    ) : (
                      <>
                        <p className="card-note">Rated games against someone near your rating. The clock always runs.</p>
                        <div className="opts">
                          <Chips
                            label="Rules"
                            value={quickMode}
                            onChange={setQuickMode}
                            options={[
                              { value: 'classic', label: 'Classic' },
                              { value: 'street', label: 'Lunch Table' },
                            ]}
                          />
                          <Chips label="Clock" value={quickClock} onChange={setQuickClock} options={QUICK_CLOCKS.map((c) => ({ value: c as number, label: clockLabel(c) }))} />
                        </div>
                      </>
                    )}
                    <button className={`btn play-btn ${search ? '' : 'primary'}`} onClick={go} disabled={!!unfinished}>
                      {search ? 'Cancel' : 'Find opponent'}
                    </button>
                  </>
                )
              ) : opp === 'friend' && net.role === 'guest' ? (
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
                        <Switch label="Swap matching hands 3-3 → 3-3" on={!!rules.swap} disabled={!rules.splits} onChange={(v) => setRules({ ...rules, swap: v })} />
                        {rules.swap && rules.splits && <p className="custom-note">A swap uses your turn. Repeat the same position three times and the game is a draw.</p>}
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
            {daily && (
              <button className="daily-cta" onClick={() => setScreen('puzzles')}>
                <Puzzle size={20} />
                <span>
                  <b>Daily puzzle</b>
                  <small>{daily.solved_today ? 'Solved today. See you tomorrow.' : `Win in ${daily.puzzle.moves}. Everyone gets the same one.`}</small>
                </span>
                <span className={`daily-streak ${daily.streak ? 'lit' : ''}`}>
                  <Flame size={16} /> {daily.streak}
                </span>
              </button>
            )}
          </div>
        )}

        {screen === 'puzzles' && <Puzzles signedIn={!!ap} skin={me.skin} view={view} onView={setView} onSignUp={() => openAuth('signup')} onProgress={() => void account.refresh()} />}
        {screen === 'leaderboard' && <Leaderboard me={uid ?? null} onOpen={openProfile} />}
        {screen === 'replay' && <GameViewer key={routeArg} id={Number(routeArg)} view={view} onView={setView} onOpen={openProfile} />}
        {screen === 'learn' && <Learn skin={SKINS[me.skin]} onPlay={() => setScreen('lobby')} />}
        {screen === 'profile' && (accountsEnabled ? <ProfilePage username={routeArg} account={account} onOpen={openProfile} onReplay={openReplay} onChallenge={sendChallenge} /> : <div className="screen"><h1>Profiles need accounts, which aren't switched on yet.</h1></div>)}
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
          <Switch
            label="Sound"
            on={!muted}
            onChange={(v) => {
              setMuted(!v);
              setMute(!v);
            }}
          />
          {accountsEnabled && <Switch label="Chat in online games" on={chatPref === 'on'} onChange={(v) => setChatPref(v ? 'on' : 'off')} />}
          {ap ? (
            <div className="account-actions">
              <ChangePassword username={ap.username} />
              <button className="link-btn danger" onClick={() => (setSheet(null), void account.signOut())}>
                Log out
              </button>
            </div>
          ) : accountsEnabled ? (
            <div className="guest-cta">
              <p className="muted">You're playing as a guest. Your rating is saved on this device only.</p>
              <button className="btn primary" onClick={() => (setSheet(null), openAuth('signup'))}>
                Create an account
              </button>
              <button className="link-btn center" onClick={() => (setSheet(null), openAuth('login'))}>
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

      {friendsOpen && <FriendsSheet onClose={() => setFriendsOpen(false)} onOpen={openProfile} onChallenge={sendChallenge} onChange={() => void beat()} />}

      {(incoming.length > 0 || sent) && (
        <div className="toasts" role="status">
          {incoming.map((c) => (
            <div className="toast" key={c.id}>
              <Avatar name={c.from.display_name} color={SKINS[c.from.skin] ?? SKINS[1]} size={36} />
              <span>
                <b>{c.from.display_name}</b> challenges you
                <small>
                  {c.mode === 'street' ? 'Lunch Table' : 'Classic'} · {clockLabel(c.clock)} · rated
                </small>
              </span>
              <button className="btn primary small" onClick={() => answer(c, true)}>
                <Swords size={15} /> Play
              </button>
              <button className="icon-btn" aria-label="Decline" onClick={() => answer(c, false)}>
                <X size={17} />
              </button>
            </div>
          ))}
          {sent && (
            <div className="toast">
              <span>
                {sent.note ?? (
                  <>
                    Waiting for <b>{sent.to}</b> to accept…
                  </>
                )}
              </span>
              <button
                className="icon-btn"
                aria-label={sent.note ? 'Dismiss' : 'Cancel challenge'}
                onClick={() => {
                  if (!sent.note && sent.id) void cancelChallenge(sent.id);
                  setSent(null);
                }}
              >
                <X size={17} />
              </button>
            </div>
          )}
        </div>
      )}
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
