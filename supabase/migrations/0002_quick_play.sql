-- ChopStiX: quick play against strangers.
-- The server owns these games: every move goes through play_move, which checks
-- the turn, replays the moves, runs the clocks, and rates the game when it ends.
-- No client ever reports a result.

-- ---------------------------------------------------------------- live matches
create table public.matches (
  id uuid primary key default gen_random_uuid(),
  player_a uuid not null references public.profiles (id) on delete cascade, -- side 0 (moves first)
  player_b uuid not null references public.profiles (id) on delete cascade, -- side 1
  rules jsonb not null,
  clock int not null check (clock between 15 and 1800), -- seconds per player
  moves jsonb not null default '[]',
  clock_a_ms int not null, -- time left as of last_move_at
  clock_b_ms int not null,
  last_move_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'finished', 'aborted')),
  winner smallint check (winner in (0, 1)), -- null = draw (or aborted)
  reason text,
  a_before int, a_delta int,
  b_before int, b_delta int,
  rematch_a boolean not null default false,
  rematch_b boolean not null default false,
  next_match uuid references public.matches (id),
  created_at timestamptz not null default now()
);
create index matches_active_a on public.matches (player_a) where status = 'active';
create index matches_active_b on public.matches (player_b) where status = 'active';
alter table public.matches enable row level security;
create policy "matches are public" on public.matches for select using (true); -- moves are public anyway, and it allows spectating later

-- Players waiting for an opponent. Rows go stale if the client stops polling.
create table public.match_queue (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  mode text not null check (mode in ('classic', 'street')),
  clock int not null,
  rating int not null,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table public.match_queue enable row level security; -- no policies: functions only

-- Live updates for both players.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.matches;
  end if;
end $$;

-- ---------------------------------------------------------------- helpers
-- The rules for each quick-play mode (mirror of CLASSIC / STREET in src/game/rules.ts).
create function public.cx_mode_rules(p_mode text) returns jsonb
language sql immutable as $$
  select case p_mode
    when 'classic' then '{"overflow":"cutoff","splits":true,"revive":true,"suicide":false,"mirror":false,"selfTap":false}'::jsonb
    when 'street' then '{"overflow":"cutoff","splits":true,"revive":true,"suicide":true,"mirror":true,"selfTap":false}'::jsonb
  end;
$$;

-- What clients get back: the row, how long the side to move has been thinking, and both players.
create function public.cx_match_json(p_match uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(m)
    || jsonb_build_object(
      'elapsed_ms', floor(extract(epoch from (clock_timestamp() - m.last_move_at)) * 1000)::int,
      'players', jsonb_build_array(
        (select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'skin', p.skin, 'rating', p.rating) from public.profiles p where p.id = m.player_a),
        (select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'skin', p.skin, 'rating', p.rating) from public.profiles p where p.id = m.player_b)
      ))
  from public.matches m where m.id = p_match;
$$;

create function public.cx_new_match(p_a uuid, p_b uuid, p_rules jsonb, p_clock int) returns uuid
language sql security definer set search_path = public as $$
  insert into public.matches (player_a, player_b, rules, clock, clock_a_ms, clock_b_ms)
  values (p_a, p_b, p_rules, p_clock, p_clock * 1000, p_clock * 1000)
  returning id;
$$;

-- End a match: rate it (unless aborted) and file it with the other games. Caller holds the match lock.
create function public.cx_end_match(p_match uuid, p_winner smallint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.matches;
  ra int; rb int;
  res_a jsonb; res_b jsonb;
begin
  select * into m from public.matches where id = p_match;
  if m.status <> 'active' then return; end if;
  if p_reason = 'aborted' then
    update public.matches set status = 'aborted', reason = 'aborted' where id = p_match;
    return;
  end if;
  -- lock in a fixed order so two games ending at once can't deadlock
  perform 1 from public.profiles where id in (m.player_a, m.player_b) order by id for update;
  select rating into ra from public.profiles where id = m.player_a;
  select rating into rb from public.profiles where id = m.player_b;
  res_a := public.cx_apply(m.player_a, rb, case when p_winner is null then 0.5 when p_winner = 0 then 1 else 0 end);
  res_b := public.cx_apply(m.player_b, ra, case when p_winner is null then 0.5 when p_winner = 1 then 1 else 0 end);
  update public.matches set
    status = 'finished', winner = p_winner, reason = p_reason,
    a_before = (res_a ->> 'before')::int, a_delta = (res_a ->> 'delta')::int,
    b_before = (res_b ->> 'before')::int, b_delta = (res_b ->> 'delta')::int
  where id = p_match;
  insert into public.games (game_key, kind, player_a, player_b, winner, reason, rules, moves, a_before, a_delta, b_before, b_delta)
  values ('q-' || p_match, 'online', m.player_a, m.player_b, p_winner, p_reason, m.rules, m.moves,
          (res_a ->> 'before')::int, (res_a ->> 'delta')::int, (res_b ->> 'before')::int, (res_b ->> 'delta')::int);
end $$;

-- Lock a match and work out which side the caller plays.
create function public.cx_my_side(m public.matches) returns smallint
language plpgsql stable as $$
begin
  if auth.uid() is null then raise exception 'sign in to play online'; end if;
  if m.id is null then raise exception 'no such game'; end if;
  if auth.uid() = m.player_a then return 0; end if;
  if auth.uid() = m.player_b then return 1; end if;
  raise exception 'you are not playing in this game';
end $$;

-- End the game if the side to move has run out of time (or never made a first move).
-- Returns true when it ended the game.
create function public.cx_check_clock(p_match uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  m public.matches;
  n int;
  elapsed int;
begin
  select * into m from public.matches where id = p_match;
  if m.status <> 'active' then return false; end if;
  n := jsonb_array_length(m.moves);
  elapsed := floor(extract(epoch from (clock_timestamp() - m.last_move_at)) * 1000)::int;
  if n < 2 then
    -- Clocks start after each side's first move. Until then you get 30 seconds or the game is called off.
    if elapsed >= 30000 then perform public.cx_end_match(p_match, null, 'aborted'); return true; end if;
  elsif (case when n % 2 = 0 then m.clock_a_ms else m.clock_b_ms end) - elapsed <= 0 then
    perform public.cx_end_match(p_match, (1 - n % 2)::smallint, 'time');
    return true;
  end if;
  return false;
end $$;

-- ---------------------------------------------------------------- matchmaking
-- Poll this every couple of seconds while searching. It returns your game as soon as there is one.
create function public.find_match(p_mode text, p_clock int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_rating int;
  my_wait numeric;
  opp public.match_queue;
  mid uuid;
begin
  if me is null then raise exception 'sign in to play online'; end if;
  if public.cx_mode_rules(p_mode) is null or p_clock not in (30, 60, 180) then raise exception 'unknown game type'; end if;

  -- One queue at a time: matchmaking is serialised so two players can't grab each other at once.
  perform pg_advisory_xact_lock(hashtext('chopstix.match_queue'));

  select id into mid from public.matches where status = 'active' and (player_a = me or player_b = me) limit 1;
  if found then
    delete from public.match_queue where user_id = me;
    return jsonb_build_object('status', 'matched', 'match', public.cx_match_json(mid));
  end if;

  delete from public.match_queue where last_seen < now() - interval '10 seconds';
  select rating into my_rating from public.profiles where id = me;
  insert into public.match_queue (user_id, mode, clock, rating) values (me, p_mode, p_clock, my_rating)
  on conflict (user_id) do update set
    mode = excluded.mode, clock = excluded.clock, rating = excluded.rating, last_seen = now(),
    joined_at = case when match_queue.mode = excluded.mode and match_queue.clock = excluded.clock then match_queue.joined_at else now() end;
  select extract(epoch from now() - joined_at) into my_wait from public.match_queue where user_id = me;

  -- Closest rating first. The window widens the longer either of you has waited.
  select * into opp from public.match_queue q
  where q.user_id <> me and q.mode = p_mode and q.clock = p_clock
    and abs(q.rating - my_rating) <= 100 + 25 * greatest(my_wait, extract(epoch from now() - q.joined_at))
  order by abs(q.rating - my_rating), q.joined_at
  limit 1;
  if not found then return jsonb_build_object('status', 'queued', 'waited', floor(my_wait)); end if;

  delete from public.match_queue where user_id in (me, opp.user_id);
  if random() < 0.5 then mid := public.cx_new_match(me, opp.user_id, public.cx_mode_rules(p_mode), p_clock);
  else mid := public.cx_new_match(opp.user_id, me, public.cx_mode_rules(p_mode), p_clock);
  end if;
  return jsonb_build_object('status', 'matched', 'match', public.cx_match_json(mid));
end $$;

create function public.leave_queue() returns void
language sql security definer set search_path = public as $$
  delete from public.match_queue where user_id = auth.uid();
$$;

-- Your unfinished game, if any (after a reload or a dropped connection).
create function public.current_match() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  mid uuid;
begin
  select id into mid from public.matches where status = 'active' and (player_a = auth.uid() or player_b = auth.uid()) limit 1 for update;
  if not found then return null; end if;
  if public.cx_check_clock(mid) then return null; end if;
  return public.cx_match_json(mid);
end $$;

-- ---------------------------------------------------------------- playing
create function public.get_match(p_match uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return public.cx_match_json(p_match);
end $$;

create function public.play_move(p_match uuid, p_ply int, p_move jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m public.matches;
  side smallint;
  n int;
  elapsed int;
  mv jsonb;
  all_moves jsonb;
  rep jsonb;
begin
  select * into m from public.matches where id = p_match for update;
  side := public.cx_my_side(m);
  if m.status <> 'active' then raise exception 'the game is over'; end if;
  if public.cx_check_clock(p_match) then return public.cx_match_json(p_match); end if;
  n := jsonb_array_length(m.moves);
  if p_ply <> n then raise exception 'out of sync: the game is at move %', n; end if;
  if n % 2 <> side then raise exception 'not your turn'; end if;

  -- Store only the fields the rules use.
  mv := case p_move ->> 'kind'
    when 'attack' then jsonb_build_object('kind', 'attack', 'from', (p_move ->> 'from')::int, 'to', (p_move ->> 'to')::int)
    when 'self' then jsonb_build_object('kind', 'self', 'from', (p_move ->> 'from')::int)
    when 'split' then jsonb_build_object('kind', 'split', 'to', jsonb_build_array((p_move -> 'to' ->> 0)::int, (p_move -> 'to' ->> 1)::int))
  end;
  if mv is null then raise exception 'unknown move'; end if;
  all_moves := m.moves || jsonb_build_array(mv);
  rep := public.cx_replay(m.rules, all_moves); -- raises on an illegal move

  elapsed := floor(extract(epoch from (clock_timestamp() - m.last_move_at)) * 1000)::int;
  update public.matches set
    moves = all_moves,
    clock_a_ms = case when side = 0 and n >= 2 then clock_a_ms - elapsed else clock_a_ms end,
    clock_b_ms = case when side = 1 and n >= 2 then clock_b_ms - elapsed else clock_b_ms end,
    last_move_at = clock_timestamp()
  where id = p_match;

  if rep ->> 'winner' is not null then perform public.cx_end_match(p_match, (rep ->> 'winner')::smallint, 'knockout');
  elsif (rep ->> 'threefold')::boolean then perform public.cx_end_match(p_match, null, 'repetition');
  end if;
  return public.cx_match_json(p_match);
end $$;

create function public.resign_match(p_match uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m public.matches;
  side smallint;
begin
  select * into m from public.matches where id = p_match for update;
  side := public.cx_my_side(m);
  if m.status = 'active' and not public.cx_check_clock(p_match) then
    -- Leaving before both sides have moved calls the game off instead of losing it.
    if jsonb_array_length(m.moves) < 2 then perform public.cx_end_match(p_match, null, 'aborted');
    else perform public.cx_end_match(p_match, (1 - side)::smallint, 'resignation');
    end if;
  end if;
  return public.cx_match_json(p_match);
end $$;

-- Either player calls this when a clock reaches zero on their screen; the server decides.
create function public.claim_timeout(p_match uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m public.matches;
begin
  select * into m from public.matches where id = p_match for update;
  perform public.cx_my_side(m);
  perform public.cx_check_clock(p_match);
  return public.cx_match_json(p_match);
end $$;

-- Both players ask, then a new game starts with sides swapped.
create function public.request_rematch(p_match uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m public.matches;
  side smallint;
  mid uuid;
begin
  select * into m from public.matches where id = p_match for update;
  side := public.cx_my_side(m);
  if m.status = 'active' then raise exception 'the game is still going'; end if;
  if m.next_match is null then
    update public.matches set rematch_a = rematch_a or side = 0, rematch_b = rematch_b or side = 1
    where id = p_match returning * into m;
    if m.rematch_a and m.rematch_b
       and not exists (select 1 from public.matches where status = 'active' and (player_a in (m.player_a, m.player_b) or player_b in (m.player_a, m.player_b))) then
      mid := public.cx_new_match(m.player_b, m.player_a, m.rules, m.clock);
      update public.matches set next_match = mid where id = p_match;
    end if;
  end if;
  return public.cx_match_json(p_match);
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
