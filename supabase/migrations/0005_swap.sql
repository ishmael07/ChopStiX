-- Custom rule "swap": matching hands (3-3) may swap places as a move. It is a split that
-- leaves the counts unchanged, so it is allowed only when both hands match and are alive.
-- Threefold repetition (already in cx_replay) is what stops it going on forever.

create or replace function public.cx_replay(p_rules jsonb, p_moves jsonb) returns jsonb
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
  can_swap boolean := coalesce((p_rules ->> 'swap')::boolean, false);
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
         or (l = h[me + 1] and r = h[me + 2] and not (can_swap and l = r and l > 0))
         or (not can_flip and l = h[me + 2] and r = h[me + 1] and l <> r)
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

create or replace function public.cx_step(p_rules jsonb, h int[], turn int, m jsonb) returns int[]
language plpgsql immutable as $$
declare
  me int := turn * 2; op int := (1 - turn) * 2;
  cutoff boolean := coalesce(p_rules ->> 'overflow', 'cutoff') = 'cutoff';
  can_swap boolean := coalesce((p_rules ->> 'swap')::boolean, false);
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
         or (l = h[me + 1] and r = h[me + 2] and not (can_swap and l = r and l > 0))
         or (not coalesce((p_rules ->> 'mirror')::boolean, false) and l = h[me + 2] and r = h[me + 1] and l <> r)
         or (not coalesce((p_rules ->> 'suicide')::boolean, false) and (l = 0 or r = 0))
         or (not coalesce((p_rules ->> 'revive')::boolean, true) and ((h[me + 1] = 0 and l > 0) or (h[me + 2] = 0 and r > 0))) then
        raise exception 'illegal split';
      end if;
      h[me + 1] := l; h[me + 2] := r;
    else raise exception 'unknown move';
  end case;
  return h;
end $$;
