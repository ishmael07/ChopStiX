-- ChopStiX: reasons to come back. Puzzles and daily streaks, leaderboards, friends and
-- challenges, badges, and chat in online games. Puzzle data is in 0004_puzzle_data.sql.

-- ---------------------------------------------------------------- profile additions
alter table public.profiles
  add column puzzle_rating int not null default 800,
  add column puzzles_attempted int not null default 0,
  add column puzzles_solved int not null default 0,
  add column daily_streak int not null default 0,      -- as of last_daily; it is broken if last_daily is before yesterday
  add column best_daily_streak int not null default 0,
  add column last_daily date,
  add column last_seen timestamptz;

-- ---------------------------------------------------------------- the solved game
-- Every position (side to move first, each pair of hands sorted), solved by src/game/solver.ts.
create table public.cx_solver (
  mode text not null,
  k int not null,
  outcome text not null check (outcome in ('win', 'loss', 'draw')),
  dtm int not null, -- plies until the knockout
  primary key (mode, k)
);
alter table public.cx_solver enable row level security; -- no policies: functions only

create function public.cx_canon(h int[], turn int) returns int
language sql immutable as $$
  select ((least(h[turn * 2 + 1], h[turn * 2 + 2]) * 5 + greatest(h[turn * 2 + 1], h[turn * 2 + 2])) * 5
         + least(h[(1 - turn) * 2 + 1], h[(1 - turn) * 2 + 2])) * 5 + greatest(h[(1 - turn) * 2 + 1], h[(1 - turn) * 2 + 2]);
$$;

-- One move from any position (mirror of applyMove/legalMoves in src/game/rules.ts). Raises on an illegal move.
create function public.cx_step(p_rules jsonb, h int[], turn int, m jsonb) returns int[]
language plpgsql immutable as $$
declare
  me int := turn * 2; op int := (1 - turn) * 2;
  cutoff boolean := coalesce(p_rules ->> 'overflow', 'cutoff') = 'cutoff';
  fr int; t int; v int; l int; r int;
begin
  if h[1] + h[2] = 0 or h[3] + h[4] = 0 then raise exception 'the game is over'; end if;
  case m ->> 'kind'
    when 'attack' then
      fr := (m ->> 'from')::int; t := (m ->> 'to')::int;
      if fr not in (0, 1) or t not in (0, 1) or h[me + fr + 1] = 0 or h[op + t + 1] = 0 then raise exception 'illegal tap'; end if;
      v := h[op + t + 1] + h[me + fr + 1];
      h[op + t + 1] := case when cutoff then (case when v >= 5 then 0 else v end) else v % 5 end;
    when 'self' then
      fr := (m ->> 'from')::int;
      if not coalesce((p_rules ->> 'selfTap')::boolean, false) or fr not in (0, 1) or h[me + fr + 1] = 0 or h[me + (1 - fr) + 1] = 0 then raise exception 'illegal self-tap'; end if;
      v := h[me + (1 - fr) + 1] + h[me + fr + 1];
      h[me + (1 - fr) + 1] := case when cutoff then (case when v >= 5 then 0 else v end) else v % 5 end;
    when 'split' then
      l := (m -> 'to' ->> 0)::int; r := (m -> 'to' ->> 1)::int;
      if not coalesce((p_rules ->> 'splits')::boolean, true) or l is null or r is null or l < 0 or r < 0 or l > 4 or r > 4
         or l + r <> h[me + 1] + h[me + 2]
         or (l = h[me + 1] and r = h[me + 2])
         or (not coalesce((p_rules ->> 'mirror')::boolean, false) and l = h[me + 2] and r = h[me + 1])
         or (not coalesce((p_rules ->> 'suicide')::boolean, false) and (l = 0 or r = 0))
         or (not coalesce((p_rules ->> 'revive')::boolean, true) and ((h[me + 1] = 0 and l > 0) or (h[me + 2] = 0 and r > 0))) then
        raise exception 'illegal split';
      end if;
      h[me + 1] := l; h[me + 2] := r;
    else raise exception 'unknown move';
  end case;
  return h;
end $$;

-- ---------------------------------------------------------------- puzzles
create table public.puzzles (
  id serial primary key,
  mode text not null,
  rules jsonb not null,
  hands jsonb not null, -- [[your L, your R], [their L, their R]]; you move first
  moves int not null,   -- win in this many of your moves
  rating int not null,
  solves int not null default 0,
  attempts int not null default 0
);
alter table public.puzzles enable row level security;
create policy "puzzles are public" on public.puzzles for select using (true);

create table public.puzzle_attempts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  puzzle_id int not null references public.puzzles (id) on delete cascade,
  solved boolean not null,
  delta int not null,
  created_at timestamptz not null default now(),
  primary key (user_id, puzzle_id)
);
alter table public.puzzle_attempts enable row level security;
create policy "see your own attempts" on public.puzzle_attempts for select using (user_id = auth.uid());

create table public.daily_puzzles (
  day date primary key,
  puzzle_id int not null references public.puzzles (id)
);
alter table public.daily_puzzles enable row level security;
create policy "daily puzzles are public" on public.daily_puzzles for select using (true);

create function public.cx_today() returns date
language sql stable as $$ select (now() at time zone 'utc')::date $$;

-- A streak only counts if you solved yesterday's or today's daily.
create function public.cx_live_streak(p public.profiles) returns int
language sql stable as $$
  select case when p.last_daily >= public.cx_today() - 1 then p.daily_streak else 0 end;
$$;

-- Today's puzzle, picked once per day: the least-used puzzle, in a scrambled order.
create function public.daily_puzzle() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d date := public.cx_today();
  pid int;
  me public.profiles;
begin
  select puzzle_id into pid from public.daily_puzzles where day = d;
  if not found then
    insert into public.daily_puzzles (day, puzzle_id)
    select d, p.id from public.puzzles p
    order by (select count(*) from public.daily_puzzles x where x.puzzle_id = p.id), hashtext(p.id || ':' || d)
    limit 1
    on conflict (day) do nothing;
    select puzzle_id into pid from public.daily_puzzles where day = d;
  end if;
  select * into me from public.profiles where id = auth.uid();
  return jsonb_build_object(
    'day', d,
    'puzzle', (select to_jsonb(p) from public.puzzles p where p.id = pid),
    'solved_today', coalesce(me.last_daily = d, false),
    'streak', coalesce(public.cx_live_streak(me), 0),
    'best_streak', coalesce(me.best_daily_streak, 0)
  );
end $$;

-- A puzzle near your puzzle rating that you haven't tried yet (any puzzle for guests).
create function public.next_puzzle(p_skip int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r int := coalesce((select puzzle_rating from public.profiles where id = me), 800);
  pz jsonb;
begin
  select to_jsonb(p) into pz from (
    select * from public.puzzles p
    where p.id is distinct from p_skip
      and (me is null or not exists (select 1 from public.puzzle_attempts a where a.user_id = me and a.puzzle_id = p.id))
    order by abs(p.rating - r) limit 6
  ) p order by random() limit 1;
  if pz is null then -- tried them all: practise a random one
    select to_jsonb(p) into pz from public.puzzles p where p.id is distinct from p_skip order by random() limit 1;
  end if;
  return pz;
end $$;

-- Check a puzzle answer move by move against the solver. Your moves must keep the fastest win;
-- the opponent's replies must be the toughest defence (what the app plays). The first try at a
-- puzzle is rated; solving today's daily (on any try) extends your streak.
create function public.submit_puzzle(p_puzzle int, p_moves jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  pz public.puzzles;
  h int[];
  turn int := 0;
  cur public.cx_solver;
  nxt public.cx_solver;
  m jsonb;
  solved boolean := false;
  failed boolean := false;
  first boolean;
  prof public.profiles;
  d int := 0;
  score numeric;
  is_daily boolean;
  today date := public.cx_today();
begin
  select * into pz from public.puzzles where id = p_puzzle;
  if not found then raise exception 'no such puzzle'; end if;
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) = 0 or jsonb_array_length(p_moves) > 40 then raise exception 'bad answer'; end if;
  h := array[(pz.hands -> 0 ->> 0)::int, (pz.hands -> 0 ->> 1)::int, (pz.hands -> 1 ->> 0)::int, (pz.hands -> 1 ->> 1)::int];

  for m in select value from jsonb_array_elements(p_moves) loop
    if solved or failed then raise exception 'moves after the puzzle ended'; end if;
    select * into cur from public.cx_solver where mode = pz.mode and k = public.cx_canon(h, turn);
    h := public.cx_step(pz.rules, h, turn, m);
    turn := 1 - turn;
    select * into nxt from public.cx_solver where mode = pz.mode and k = public.cx_canon(h, turn);
    if turn = 1 then -- that was your move: it has to keep the fastest win
      if nxt.outcome <> 'loss' or nxt.dtm <> cur.dtm - 1 then failed := true;
      elsif h[3] + h[4] = 0 then solved := true;
      end if;
    elsif nxt.outcome <> 'win' or nxt.dtm <> cur.dtm - 1 then
      raise exception 'that is not the reply the puzzle plays';
    end if;
  end loop;
  if not solved and not failed then raise exception 'the puzzle is not finished'; end if;

  update public.puzzles set attempts = attempts + 1, solves = solves + solved::int where id = pz.id;
  if me is null then return jsonb_build_object('solved', solved, 'status', 'guest'); end if;

  select * into prof from public.profiles where id = me for update;
  first := not exists (select 1 from public.puzzle_attempts where user_id = me and puzzle_id = pz.id);
  if first then
    score := case when solved then 1 else 0 end;
    d := public.cx_elo_delta(prof.puzzle_rating, pz.rating, score, prof.puzzles_attempted);
    insert into public.puzzle_attempts (user_id, puzzle_id, solved, delta) values (me, pz.id, solved, d);
    update public.profiles set
      puzzle_rating = puzzle_rating + d,
      puzzles_attempted = puzzles_attempted + 1,
      puzzles_solved = puzzles_solved + solved::int
    where id = me returning * into prof;
    -- puzzles drift towards how hard people actually find them
    update public.puzzles set rating = greatest(100, rating - round(8 * (score - 1 / (1 + power(10, (rating - (prof.puzzle_rating - d)) / 400.0))))::int)
    where id = pz.id;
  end if;

  is_daily := exists (select 1 from public.daily_puzzles where day = today and puzzle_id = pz.id);
  if is_daily and solved and prof.last_daily is distinct from today then
    update public.profiles set
      daily_streak = case when last_daily = today - 1 then daily_streak + 1 else 1 end,
      best_daily_streak = greatest(best_daily_streak, case when last_daily = today - 1 then daily_streak + 1 else 1 end),
      last_daily = today
    where id = me returning * into prof;
  end if;

  return jsonb_build_object(
    'solved', solved, 'status', case when first then 'rated' else 'practice' end,
    'delta', d, 'puzzle_rating', prof.puzzle_rating,
    'daily', is_daily, 'streak', public.cx_live_streak(prof), 'best_streak', prof.best_daily_streak
  );
end $$;

-- ---------------------------------------------------------------- friends
create table public.friendships (
  a uuid not null references public.profiles (id) on delete cascade, -- a < b, so each pair is one row
  b uuid not null references public.profiles (id) on delete cascade,
  requested_by uuid not null,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);
alter table public.friendships enable row level security; -- functions only

create function public.cx_are_friends(x uuid, y uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships where a = least(x, y) and b = greatest(x, y) and status = 'accepted');
$$;

-- Ask someone to be friends. If they already asked you, you're friends.
create function public.friend_request(p_user uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  f public.friendships;
begin
  if me is null then raise exception 'sign in first'; end if;
  if p_user = me or not exists (select 1 from public.profiles where id = p_user) then raise exception 'no such player'; end if;
  select * into f from public.friendships where a = least(me, p_user) and b = greatest(me, p_user) for update;
  if not found then
    if (select count(*) from public.friendships where requested_by = me and status = 'pending') >= 50 then
      raise exception 'too many friend requests waiting';
    end if;
    insert into public.friendships (a, b, requested_by) values (least(me, p_user), greatest(me, p_user), me);
    return 'outgoing';
  elsif f.status = 'pending' and f.requested_by <> me then
    update public.friendships set status = 'accepted' where a = f.a and b = f.b;
    return 'friends';
  end if;
  return case when f.status = 'accepted' then 'friends' else 'outgoing' end;
end $$;

-- Decline a request, cancel yours, or unfriend.
create function public.friend_remove(p_user uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.friendships where a = least(auth.uid(), p_user) and b = greatest(auth.uid(), p_user);
$$;

-- Everyone you're friends with or have a request with, online first.
create function public.friends_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x ->> 'status' = 'incoming' desc, (x ->> 'online')::boolean desc, x ->> 'display_name'), '[]')
  from (
    select jsonb_build_object(
      'id', p.id, 'username', p.username, 'display_name', p.display_name, 'skin', p.skin, 'rating', p.rating,
      'online', coalesce(p.last_seen > now() - interval '2 minutes', false),
      'status', case when f.status = 'accepted' then 'friends' when f.requested_by = auth.uid() then 'outgoing' else 'incoming' end
    ) x
    from public.friendships f
    join public.profiles p on p.id = case when f.a = auth.uid() then f.b else f.a end
    where auth.uid() in (f.a, f.b)
  ) t;
$$;

-- ---------------------------------------------------------------- challenges
create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  mode text not null,
  clock int not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  match_id uuid references public.matches (id),
  created_at timestamptz not null default now()
);
create index challenges_to on public.challenges (to_user, created_at desc);
create index challenges_from on public.challenges (from_user, created_at desc);
alter table public.challenges enable row level security; -- functions only

create function public.challenge_friend(p_user uuid, p_mode text, p_clock int) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid uuid;
begin
  if me is null then raise exception 'sign in first'; end if;
  if not public.cx_are_friends(me, p_user) then raise exception 'you can only challenge friends'; end if;
  if public.cx_mode_rules(p_mode) is null or p_clock not in (30, 60, 180) then raise exception 'unknown game type'; end if;
  update public.challenges set status = 'cancelled' where from_user = me and status = 'pending';
  insert into public.challenges (from_user, to_user, mode, clock) values (me, p_user, p_mode, p_clock) returning id into cid;
  return cid;
end $$;

create function public.cancel_challenge(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.challenges set status = 'cancelled' where id = p_id and from_user = auth.uid() and status = 'pending';
$$;

-- Accepting starts a server-run game (see 0002_quick_play.sql) with random sides.
create function public.respond_challenge(p_id uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  c public.challenges;
  mid uuid;
begin
  select * into c from public.challenges where id = p_id and to_user = me for update;
  if not found or c.status <> 'pending' or c.created_at < now() - interval '2 minutes' then raise exception 'that challenge has expired'; end if;
  if not p_accept then
    update public.challenges set status = 'declined' where id = p_id;
    return null;
  end if;
  if exists (select 1 from public.matches where status = 'active' and (player_a in (me, c.from_user) or player_b in (me, c.from_user))) then
    raise exception 'one of you is already in a game';
  end if;
  if random() < 0.5 then mid := public.cx_new_match(me, c.from_user, public.cx_mode_rules(c.mode), c.clock);
  else mid := public.cx_new_match(c.from_user, me, public.cx_mode_rules(c.mode), c.clock);
  end if;
  update public.challenges set status = 'accepted', match_id = mid where id = p_id;
  return public.cx_match_json(mid);
end $$;

-- Called every few seconds while the app is open: marks you online and returns what needs your attention.
create function public.heartbeat() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then return null; end if;
  update public.profiles set last_seen = now() where id = me;
  return jsonb_build_object(
    'challenges', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'mode', c.mode, 'clock', c.clock,
        'from', jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'skin', p.skin, 'rating', p.rating)) order by c.created_at desc), '[]')
      from public.challenges c join public.profiles p on p.id = c.from_user
      where c.to_user = me and c.status = 'pending' and c.created_at > now() - interval '2 minutes'
    ),
    'sent', (
      select jsonb_build_object('id', c.id, 'status', case when c.status = 'pending' and c.created_at < now() - interval '2 minutes' then 'expired' else c.status end,
        'to', p.display_name, 'match', case when c.match_id is not null then public.cx_match_json(c.match_id) end)
      from public.challenges c join public.profiles p on p.id = c.to_user
      where c.from_user = me and c.created_at > now() - interval '3 minutes'
      order by c.created_at desc limit 1
    ),
    'friend_requests', (
      select count(*) from public.friendships f where me in (f.a, f.b) and f.status = 'pending' and f.requested_by <> me
    )
  );
end $$;

-- ---------------------------------------------------------------- leaderboards
-- kind: rating | weekly (rating gained in 7 days) | puzzles | streak | friends
create function public.leaderboard(p_kind text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  rows jsonb;
  mine jsonb;
begin
  if p_kind not in ('rating', 'weekly', 'puzzles', 'streak', 'friends') then raise exception 'unknown leaderboard'; end if;
  with board as (
    select id, rating as value from public.profiles where p_kind = 'rating' and games > 0
    union all
    select pid, sum(delta)::int from (
      select player_a pid, a_delta delta from public.games where p_kind = 'weekly' and created_at > now() - interval '7 days' and player_a is not null
      union all
      select player_b, b_delta from public.games where p_kind = 'weekly' and created_at > now() - interval '7 days' and player_b is not null
    ) g group by pid
    union all
    select id, puzzle_rating from public.profiles where p_kind = 'puzzles' and puzzles_attempted > 0
    union all
    select id, public.cx_live_streak(p) from public.profiles p where p_kind = 'streak' and public.cx_live_streak(p) > 0
    union all
    select id, rating from public.profiles p where p_kind = 'friends' and (p.id = me or public.cx_are_friends(me, p.id))
  ), ranked as (
    select b.id, b.value, rank() over (order by b.value desc) rnk from board b
  )
  select
    (select coalesce(jsonb_agg(jsonb_build_object('rank', r.rnk, 'value', r.value, 'id', p.id, 'username', p.username,
       'display_name', p.display_name, 'skin', p.skin, 'online', coalesce(p.last_seen > now() - interval '2 minutes', false)) order by r.rnk, p.username), '[]')
     from (select * from ranked order by rnk limit 50) r join public.profiles p on p.id = r.id),
    (select jsonb_build_object('rank', rnk, 'value', value) from ranked where id = me)
  into rows, mine;
  return jsonb_build_object('rows', rows, 'me', mine);
end $$;

-- ---------------------------------------------------------------- badges
-- Worked out from the record each time, so they can't be granted by the client.
create function public.player_badges(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  p public.profiles;
  out text[] := '{}';
  run int := 0;
  best_run int := 0;
  g record;
begin
  select * into p from public.profiles where id = p_user;
  if not found then return '[]'; end if;
  if p.wins >= 1 then out := array_append(out, 'first_win'); end if;
  if exists (select 1 from public.games where kind = 'online' and ((player_a = p_user and winner = 0) or (player_b = p_user and winner = 1))) then out := array_append(out, 'online_win'); end if;
  if exists (select 1 from public.games where bot_id = 'kenji' and ((player_a = p_user and winner = 0) or (player_b = p_user and winner = 1))) then out := array_append(out, 'beat_kenji'); end if;
  if exists (select 1 from public.games where bot_id = 'sensei' and ((player_a = p_user and winner = 0) or (player_b = p_user and winner = 1) or winner is null)) then out := array_append(out, 'held_sensei'); end if;
  if p.games >= 10 then out := array_append(out, 'games_10'); end if;
  if p.games >= 100 then out := array_append(out, 'games_100'); end if;
  if p.peak_rating >= 1000 then out := array_append(out, 'rating_1000'); end if;
  if p.peak_rating >= 1400 then out := array_append(out, 'rating_1400'); end if;
  if p.peak_rating >= 1800 then out := array_append(out, 'rating_1800'); end if;
  if p.puzzles_solved >= 10 then out := array_append(out, 'puzzles_10'); end if;
  if p.puzzles_solved >= 50 then out := array_append(out, 'puzzles_50'); end if;
  if p.best_daily_streak >= 3 then out := array_append(out, 'streak_3'); end if;
  if p.best_daily_streak >= 7 then out := array_append(out, 'streak_7'); end if;
  if p.best_daily_streak >= 30 then out := array_append(out, 'streak_30'); end if;
  if exists (select 1 from public.friendships where p_user in (a, b) and status = 'accepted') then out := array_append(out, 'friend'); end if;
  for g in select (player_a = p_user and winner = 0) or (player_b = p_user and winner = 1) as won
           from public.games where player_a = p_user or player_b = p_user order by created_at loop
    run := case when g.won then run + 1 else 0 end;
    best_run := greatest(best_run, run);
  end loop;
  if best_run >= 5 then out := array_append(out, 'win_streak_5'); end if;
  return to_jsonb(out);
end $$;

-- ---------------------------------------------------------------- chat in online games
create table public.match_chat (
  id bigserial primary key,
  match_id uuid not null references public.matches (id) on delete cascade,
  sender uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 140),
  created_at timestamptz not null default now()
);
create index match_chat_match on public.match_chat (match_id, id);
alter table public.match_chat enable row level security;
-- Only the two players can read a game's chat. Writing goes through send_chat.
create policy "players read their chat" on public.match_chat for select using (
  exists (select 1 from public.matches m where m.id = match_id and auth.uid() in (m.player_a, m.player_b))
);
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.match_chat;
  end if;
end $$;

-- Mask swearing and slurs, and links (keep this list in step with src/game/chat.ts).
create function public.cx_clean(p text) returns text
language sql immutable as $$
  select regexp_replace(
    regexp_replace(p, '(https?://|www\.)\S+|\m[a-z0-9-]+\.(com|net|org|gg|io|co|xyz|tv|me|ly)\M\S*', '[link]', 'gi'),
    '\m(fuck|f\*ck|fuk|shit|sh\*t|bitch|cunt|dick|cock|pussy|asshole|bastard|whore|slut|fag|nigg|retard|kys|kill yourself)\w*', '***', 'gi');
$$;

create function public.send_chat(p_match uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  m public.matches;
  body text := btrim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g'));
  row public.match_chat;
begin
  select * into m from public.matches where id = p_match;
  perform public.cx_my_side(m);
  if body = '' then raise exception 'empty message'; end if;
  if char_length(body) > 140 then raise exception 'messages are 140 characters at most'; end if;
  if (select count(*) from public.match_chat where match_id = p_match and sender = me and created_at > now() - interval '10 seconds') >= 5 then
    raise exception 'slow down a little';
  end if;
  insert into public.match_chat (match_id, sender, body) values (p_match, me, public.cx_clean(body)) returning * into row;
  return to_jsonb(row);
end $$;

create function public.get_chat(p_match uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  m public.matches;
begin
  select * into m from public.matches where id = p_match;
  perform public.cx_my_side(m);
  return (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from public.match_chat c where c.match_id = p_match);
end $$;

-- ---------------------------------------------------------------- permissions
revoke execute on all functions in schema public from public;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.record_bot_game(text, text, smallint, jsonb, jsonb, text) to authenticated;
grant execute on function public.report_online_game(text, uuid, smallint, jsonb, jsonb, smallint, text) to authenticated;
grant execute on function public.find_match(text, int) to authenticated;
grant execute on function public.leave_queue() to authenticated;
grant execute on function public.current_match() to authenticated;
grant execute on function public.get_match(uuid) to anon, authenticated;
grant execute on function public.play_move(uuid, int, jsonb) to authenticated;
grant execute on function public.resign_match(uuid) to authenticated;
grant execute on function public.claim_timeout(uuid) to authenticated;
grant execute on function public.request_rematch(uuid) to authenticated;
grant execute on function public.daily_puzzle() to anon, authenticated;
grant execute on function public.next_puzzle(int) to anon, authenticated;
grant execute on function public.submit_puzzle(int, jsonb) to anon, authenticated;
grant execute on function public.friend_request(uuid) to authenticated;
grant execute on function public.friend_remove(uuid) to authenticated;
grant execute on function public.friends_list() to authenticated;
grant execute on function public.challenge_friend(uuid, text, int) to authenticated;
grant execute on function public.cancel_challenge(uuid) to authenticated;
grant execute on function public.respond_challenge(uuid, boolean) to authenticated;
grant execute on function public.heartbeat() to authenticated;
grant execute on function public.leaderboard(text) to anon, authenticated;
grant execute on function public.player_badges(uuid) to anon, authenticated;
grant execute on function public.send_chat(uuid, text) to authenticated;
grant execute on function public.get_chat(uuid) to authenticated;
