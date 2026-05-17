-- ============================================================
-- Push notifications: subscriptions, outbox, triggers
-- Run AFTER prior migrations (handicap rename, two-scorekeeper).
--
-- Prerequisite: enable the pg_net extension in Supabase
--   (Database -> Extensions -> pg_net -> Enable).
--
-- The dispatch URL is hardcoded inside fn_dispatch_notification below.
-- If your project ref changes, edit it there and re-run that one
-- create-or-replace function block.
-- ============================================================

-- Subscriptions: one row per (player, browser endpoint).
create table if not exists push_subscriptions (
  id           bigserial primary key,
  player_id    text references players(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  created_at   timestamptz default now()
);
create index if not exists idx_push_subs_player on push_subscriptions(player_id);

-- Outbox of pending notifications, populated by triggers, processed by the Edge Function.
create table if not exists notification_events (
  id           bigserial primary key,
  type         text not null,            -- 'birdie' | 'eagle' | 'message'
  actor_id     text references players(id),
  payload      jsonb not null,           -- title/body/data fields ready for the SW
  status       text not null default 'pending',  -- pending | sent | failed
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz default now(),
  processed_at timestamptz
);
create index if not exists idx_notif_pending on notification_events(status, created_at) where status = 'pending';

-- Open RLS for the app to read subscriptions/events as needed.
-- Service role (used by the Edge Function) bypasses RLS, so policies here
-- are just for client-side reads/writes.
alter table push_subscriptions enable row level security;
alter table notification_events enable row level security;
drop policy if exists "open" on push_subscriptions;
drop policy if exists "open" on notification_events;
create policy "open" on push_subscriptions for all using (true) with check (true);
create policy "open" on notification_events for all using (true) with check (true);

-- ===== Trigger: on score insert, queue birdie/eagle event =====
create or replace function fn_queue_score_event()
returns trigger language plpgsql as $$
declare
  v_par int;
  v_stroke_index int;
  v_handicap int;
  v_format text;
  v_field_min int;
  v_strokes_on_hole int;
  v_net int;
  v_diff int;
  v_player_name text;
  v_player_emoji text;
  v_kind text;
  v_body text;
  v_strokes_received int;
  v_full_round int;
  v_remainder int;
begin
  -- Only fire on a score that was just created (not updates)
  if tg_op <> 'INSERT' then return new; end if;

  select par, stroke_index into v_par, v_stroke_index
    from holes where round_id = new.round_id and hole = new.hole;
  if v_par is null then return new; end if;

  select format into v_format from rounds where id = new.round_id;

  select handicap into v_handicap from round_strokes
    where round_id = new.round_id and player_id = new.player_id;

  if v_handicap is null then v_handicap := 0; end if;

  -- Field min handicap for the round (for best_ball / scramble / championship)
  if v_format in ('best_ball','scramble','championship') then
    select coalesce(min(handicap), 0) into v_field_min
      from round_strokes where round_id = new.round_id;
  else
    -- Group min for individual stroke
    select coalesce(min(handicap), 0) into v_field_min
      from round_strokes
      where round_id = new.round_id
        and group_assignment = (
          select group_assignment from round_strokes
          where round_id = new.round_id and player_id = new.player_id
        );
  end if;

  v_strokes_received := greatest(0, v_handicap - v_field_min);

  -- getStrokesOnHole equivalent
  if v_stroke_index is null or v_strokes_received <= 0 then
    v_strokes_on_hole := 0;
  else
    v_full_round := v_strokes_received / 18;
    v_remainder := v_strokes_received % 18;
    v_strokes_on_hole := v_full_round + (case when v_stroke_index <= v_remainder then 1 else 0 end);
  end if;

  v_net := new.gross - v_strokes_on_hole;
  v_diff := v_net - v_par;

  if v_diff > -1 then
    return new;  -- not a birdie or better, skip
  end if;

  v_kind := case when v_diff <= -2 then 'eagle' else 'birdie' end;

  select name, emoji into v_player_name, v_player_emoji
    from players where id = new.player_id;

  if v_kind = 'eagle' then
    v_body := v_player_emoji || ' ' || v_player_name || ' just netted an EAGLE on hole ' || new.hole || '!';
  else
    v_body := v_player_emoji || ' ' || v_player_name || ' just netted a birdie on hole ' || new.hole || '.';
  end if;

  insert into notification_events (type, actor_id, payload)
  values (
    v_kind,
    new.player_id,
    jsonb_build_object(
      'title', case when v_kind = 'eagle' then '🦅 Eagle!' else '🐦 Birdie' end,
      'body', v_body,
      'tag', 'score-' || new.id,
      'url', '/'
    )
  );

  return new;
end;
$$;

drop trigger if exists trg_queue_score_event on scores;
create trigger trg_queue_score_event
after insert on scores
for each row execute function fn_queue_score_event();

-- ===== Trigger: on message insert, queue trash-talk event =====
create or replace function fn_queue_message_event()
returns trigger language plpgsql as $$
declare
  v_player_name text;
  v_player_emoji text;
  v_body_short text;
begin
  if tg_op <> 'INSERT' then return new; end if;

  select name, emoji into v_player_name, v_player_emoji
    from players where id = new.player_id;

  v_body_short := substring(new.body from 1 for 140);

  insert into notification_events (type, actor_id, payload)
  values (
    'message',
    new.player_id,
    jsonb_build_object(
      'title', v_player_emoji || ' ' || v_player_name,
      'body', v_body_short,
      'tag', 'msg-' || new.id,
      'url', '/'
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_queue_message_event on messages;
create trigger trg_queue_message_event
after insert on messages
for each row execute function fn_queue_message_event();

-- ===== Trigger: on notification_events insert, fire pg_net request to Edge Function =====
-- Requires the pg_net extension (enable via Database -> Extensions in the dashboard).
-- And requires app.edge_function_url + app.edge_function_key to be set.
create or replace function fn_dispatch_notification()
returns trigger language plpgsql as $$
begin
  if new.status <> 'pending' then return new; end if;
  perform net.http_post(
    -- Replace YOUR_PROJECT_REF with your Supabase project ref before running this migration.
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('event_id', new.id)
  );
  return new;
end;
$$;

drop trigger if exists trg_dispatch_notification on notification_events;
create trigger trg_dispatch_notification
after insert on notification_events
for each row execute function fn_dispatch_notification();

-- Add to realtime publication so client can subscribe to push_subscriptions changes if needed
alter publication supabase_realtime add table push_subscriptions;
