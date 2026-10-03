-- ChopStiX: accounts, profiles, rated games.
-- Ratings are only ever changed by the security-definer functions below, which
-- replay the submitted moves server-side so a client can't invent a result.

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 24),
  skin smallint not null default 1 check (skin between 0 and 4),
  rating int not null default 800,
  peak_rating int not null default 800,
  games int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  draws int not null default 0,
  created_at timestamptz not null default now()
);
create unique index profiles_username_key on public.profiles (lower(username));

alter table public.profiles enable row level security;
create policy "profiles are public" on public.profiles for select using (true);
create policy "edit own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
-- Players may only change how they look, never their rating or record.
revoke update on public.profiles from anon, authenticated;
grant update (display_name, skin) on public.profiles to authenticated;

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name, skin)
  values (
    new.id,
    new.raw_user_meta_data ->> 'username',
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), new.raw_user_meta_data ->> 'username'),
    coalesce((new.raw_user_meta_data ->> 'skin')::smallint, 1)
  );
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_username ~ '^[A-Za-z0-9_]{3,20}$'
     and not exists (select 1 from public.profiles where lower(username) = lower(p_username));
$$;

-- ---------------------------------------------------------------- bots
create table public.bots (id text primary key, rating int not null);
insert into public.bots values ('pip', 400), ('maple', 800), ('bamboo', 1200), ('kenji', 1600), ('sensei', 2400);
alter table public.bots enable row level security;
create policy "bots are public" on public.bots for select using (true);

-- ---------------------------------------------------------------- games
create table public.games (
  id bigserial primary key,
  game_key text not null unique,
  kind text not null check (kind in ('bot', 'online')),
  player_a uuid references public.profiles (id) on delete set null, -- side 0 (moved first)
  player_b uuid references public.profiles (id) on delete set null, -- side 1
  bot_id text references public.bots (id),
  winner smallint check (winner in (0, 1)), -- null = draw
  reason text not null,
  rules jsonb not null,
  moves jsonb not null,
  a_before int, a_delta int,
  b_before int, b_delta int,
  created_at timestamptz not null default now()
);
create index games_player_a on public.games (player_a, created_at desc);
create index games_player_b on public.games (player_b, created_at desc);
alter table public.games enable row level security;
create policy "games are public" on public.games for select using (true);

-- Half-reported friend games wait here until the other player confirms.
create table public.online_reports (
  game_key text not null,
  reporter uuid not null references public.profiles (id) on delete cascade,
  opponent uuid not null references public.profiles (id) on delete cascade,
  side smallint not null check (side in (0, 1)),
  rules jsonb not null,
  moves jsonb not null,
  winner smallint,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (game_key, reporter)
);
alter table public.online_reports enable row level security; -- no policies: functions only

-- ---------------------------------------------------------------- rules engine (mirror of src/game/rules.ts)
create function public.cx_replay(p_rules jsonb, p_moves jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  h int[] := array[1, 1, 1, 1]; -- side0 L, side0 R, side1 L, side1 R
  turn int := 0;
  m jsonb;
  kind text;
  fr int; t int; me int; op int; v int; l int; r int;
  cutoff boolean := coalesce(p_rules ->> 'overflow', 'cutoff') = 'cutoff';
  can_split boolean := coalesce((p_rules ->> 'splits')::boolean, true);
  can_revive boolean := coalesce((p_rules ->> 'revive')::boolean, true);
  can_empty boolean := coalesce((p_rules ->> 'suicide')::boolean, false);
  can_flip boolean := coalesce((p_rules ->> 'mirror')::boolean, false);
  can_self boolean := coalesce((p_rules ->> 'selfTap')::boolean, false);
  seen jsonb;
  k text;
  cnt int;
  win int := null;
  threefold boolean := false;
  i int := 0;
begin
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) > 800 then
    raise exception 'invalid move list';
  end if;
  seen := jsonb_build_object(array_to_string(h, '') || turn, 1);
  for m in select value from jsonb_array_elements(p_moves) loop
    if win is not null or threefold then raise exception 'move % after the game ended', i; end if;
    me := turn * 2; op := (1 - turn) * 2;
    kind := m ->> 'kind';
    if kind = 'attack' then
      fr := (m ->> 'from')::int; t := (m ->> 'to')::int;
      if fr not in (0, 1) or t not in (0, 1) or h[me + fr + 1] = 0 or h[op + t + 1] = 0 then
        raise exception 'illegal tap at move %', i;
      end if;
      v := h[op + t + 1] + h[me + fr + 1];
      h[op + t + 1] := case when cutoff then (case when v >= 5 then 0 else v end) else v % 5 end;
    elsif kind = 'self' then
      fr := (m ->> 'from')::int;
      if not can_self or fr not in (0, 1) or h[me + fr + 1] = 0 or h[me + (1 - fr) + 1] = 0 then
        raise exception 'illegal self-tap at move %', i;
      end if;
      t := me + (1 - fr) + 1;
      v := h[t] + h[me + fr + 1];
      h[t] := case when cutoff then (case when v >= 5 then 0 else v end) else v % 5 end;
    elsif kind = 'split' then
      l := (m -> 'to' ->> 0)::int; r := (m -> 'to' ->> 1)::int;
      if not can_split or l is null or r is null or l < 0 or r < 0 or l > 4 or r > 4
         or l + r <> h[me + 1] + h[me + 2]
         or (l = h[me + 1] and r = h[me + 2])
         or (not can_flip and l = h[me + 2] and r = h[me + 1])
         or (not can_empty and (l = 0 or r = 0))
         or (not can_revive and ((h[me + 1] = 0 and l > 0) or (h[me + 2] = 0 and r > 0))) then
        raise exception 'illegal split at move %', i;
      end if;
      h[me + 1] := l; h[me + 2] := r;
    else
      raise exception 'unknown move at %', i;
    end if;
    turn := 1 - turn;
    i := i + 1;
    if h[1] + h[2] = 0 then win := 1; elsif h[3] + h[4] = 0 then win := 0; end if;
    k := array_to_string(h, '') || turn;
    cnt := coalesce((seen ->> k)::int, 0) + 1;
    seen := seen || jsonb_build_object(k, cnt);
    if win is null and cnt >= 3 then threefold := true; end if;
  end loop;
  return jsonb_build_object('winner', win, 'threefold', threefold, 'plies', i);
end $$;

-- ---------------------------------------------------------------- Elo (mirror of src/game/rating.ts)
create function public.cx_elo_delta(p_me int, p_opp int, p_score numeric, p_games int) returns int
language sql immutable as $$
  select greatest(100, p_me + round(
    (case when p_games < 20 then 40 when p_me >= 2000 then 10 else 20 end)
    * (p_score - 1 / (1 + power(10, (p_opp - p_me) / 400.0)))
  )::int) - p_me;
$$;

-- Apply a result to one player. Caller must hold the row lock.
create function public.cx_apply(p_user uuid, p_opp_rating int, p_score numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p public.profiles;
  d int;
begin
  select * into p from public.profiles where id = p_user;
  d := public.cx_elo_delta(p.rating, p_opp_rating, p_score, p.games);
  update public.profiles set
    rating = p.rating + d,
    peak_rating = greatest(p.peak_rating, p.rating + d),
    games = p.games + 1,
    wins = p.wins + (p_score = 1)::int,
    losses = p.losses + (p_score = 0)::int,
    draws = p.draws + (p_score = 0.5)::int
  where id = p_user;
  return jsonb_build_object('before', p.rating, 'delta', d, 'after', p.rating + d);
end $$;
revoke execute on function public.cx_apply(uuid, int, numeric) from public, anon, authenticated;

-- Decide a game's winner from the moves plus how it ended. Returns -1 for "not decidable".
create function public.cx_outcome(p_replay jsonb, p_reason text, p_claimed smallint) returns int
language plpgsql immutable as $$
begin
  if p_replay ->> 'winner' is not null then
    return (p_replay ->> 'winner')::int;              -- knockout is proven by the moves
  elsif (p_replay ->> 'threefold')::boolean then
    return null;                                       -- draw by repetition
  elsif p_reason in ('resignation', 'time') and p_claimed in (0, 1) then
    return p_claimed;                                  -- unfinished board: trust only what's checked by the caller
  end if;
  return -1;
end $$;

-- ---------------------------------------------------------------- record a game vs a bot
create function public.record_bot_game(
  p_key text, p_bot text, p_side smallint, p_rules jsonb, p_moves jsonb, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  bot_rating int;
  rep jsonb;
  w int;
  score numeric;
  res jsonb;
begin
  if me is null then raise exception 'sign in to play rated games'; end if;
  if p_side not in (0, 1) then raise exception 'bad side'; end if;
  select rating into bot_rating from public.bots where id = p_bot;
  if bot_rating is null then raise exception 'unknown bot'; end if;
  if exists (select 1 from public.games where game_key = p_key) then raise exception 'game already recorded'; end if;

  rep := public.cx_replay(p_rules, p_moves);
  -- Bots never resign or run out of time, so those only ever count as your loss.
  w := public.cx_outcome(rep, p_reason, (1 - p_side)::smallint);
  if w = -1 then raise exception 'game is not finished'; end if;
  score := case when w is null then 0.5 when w = p_side then 1 else 0 end;

  perform 1 from public.profiles where id = me for update;
  res := public.cx_apply(me, bot_rating, score);
  insert into public.games (game_key, kind, player_a, player_b, bot_id, winner, reason, rules, moves, a_before, a_delta, b_before, b_delta)
  values (
    p_key, 'bot',
    case when p_side = 0 then me end, case when p_side = 1 then me end,
    p_bot, w, coalesce(case when rep ->> 'winner' is not null then 'knockout' when (rep ->> 'threefold')::boolean then 'repetition' end, p_reason),
    p_rules, p_moves,
    case when p_side = 0 then (res ->> 'before')::int end, case when p_side = 0 then (res ->> 'delta')::int end,
    case when p_side = 1 then (res ->> 'before')::int end, case when p_side = 1 then (res ->> 'delta')::int end
  );
  return res || jsonb_build_object('status', 'rated');
end $$;

-- ---------------------------------------------------------------- record a friend game
-- Both players report. Ratings change only when the two reports agree.
create function public.report_online_game(
  p_key text, p_opponent uuid, p_side smallint, p_rules jsonb, p_moves jsonb, p_winner smallint, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  theirs public.online_reports;
  rep jsonb;
  w int;
  a uuid; b uuid;
  ra int; rb int;
  res_a jsonb; res_b jsonb;
  g public.games;
begin
  if me is null then raise exception 'sign in to play rated games'; end if;
  if p_opponent = me or p_side not in (0, 1) then raise exception 'bad report'; end if;

  select * into g from public.games where game_key = p_key;
  if found then
    return jsonb_build_object('status', 'rated', 'before', case when g.player_a = me then g.a_before else g.b_before end,
                              'delta', case when g.player_a = me then g.a_delta else g.b_delta end);
  end if;

  insert into public.online_reports (game_key, reporter, opponent, side, rules, moves, winner, reason)
  values (p_key, me, p_opponent, p_side, p_rules, p_moves, p_winner, p_reason)
  on conflict (game_key, reporter) do nothing;

  select * into theirs from public.online_reports
  where game_key = p_key and reporter = p_opponent and opponent = me for update;
  if not found then return jsonb_build_object('status', 'pending'); end if;

  -- The two reports must describe the same game.
  if theirs.side <> 1 - p_side or theirs.rules <> p_rules or theirs.moves <> p_moves
     or theirs.winner is distinct from p_winner then
    delete from public.online_reports where game_key = p_key;
    return jsonb_build_object('status', 'mismatch');
  end if;

  rep := public.cx_replay(p_rules, p_moves);
  w := public.cx_outcome(rep, p_reason, p_winner);
  if w = -1 or w is distinct from p_winner then
    delete from public.online_reports where game_key = p_key;
    return jsonb_build_object('status', 'mismatch');
  end if;

  a := case when p_side = 0 then me else p_opponent end;
  b := case when p_side = 0 then p_opponent else me end;
  -- lock in a fixed order so two simultaneous confirmations can't deadlock
  perform 1 from public.profiles where id in (a, b) order by id for update;
  select rating into ra from public.profiles where id = a;
  select rating into rb from public.profiles where id = b;
  res_a := public.cx_apply(a, rb, case when w is null then 0.5 when w = 0 then 1 else 0 end);
  res_b := public.cx_apply(b, ra, case when w is null then 0.5 when w = 1 then 1 else 0 end);

  insert into public.games (game_key, kind, player_a, player_b, winner, reason, rules, moves, a_before, a_delta, b_before, b_delta)
  values (p_key, 'online', a, b, w,
          coalesce(case when rep ->> 'winner' is not null then 'knockout' when (rep ->> 'threefold')::boolean then 'repetition' end, p_reason),
          p_rules, p_moves, (res_a ->> 'before')::int, (res_a ->> 'delta')::int, (res_b ->> 'before')::int, (res_b ->> 'delta')::int);
  delete from public.online_reports where game_key = p_key;

  return (case when p_side = 0 then res_a else res_b end) || jsonb_build_object('status', 'rated');
end $$;

-- Postgres lets PUBLIC execute every function by default; lock that down.
revoke execute on all functions in schema public from public;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.record_bot_game(text, text, smallint, jsonb, jsonb, text) to authenticated;
grant execute on function public.report_online_game(text, uuid, smallint, jsonb, jsonb, smallint, text) to authenticated;
