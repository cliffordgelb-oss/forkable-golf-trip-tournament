-- ============================================================
-- Forkable Golf Trip Tournament — base schema
--
-- Run this FIRST on a fresh Supabase Postgres instance, then
-- run db/seed_courses.sql to populate rounds and holes.
--
-- Notes
-- - This file is the post-migration schema as of the current
--   release. The other db/migration_*.sql files describe how
--   the original schema evolved; you do NOT need to run them
--   on a fresh install.
-- - Push notifications require the pg_net extension. Enable it
--   in the Supabase dashboard before running this file:
--     Database -> Extensions -> pg_net -> Enable
-- - Replace YOUR_PROJECT_REF in fn_dispatch_notification (near
--   the bottom of this file) with your Supabase project ref
--   before running, otherwise push notifications will fail
--   silently.
-- - The app uses Supabase's anon key for all reads/writes and
--   relies on "only my friends have the URL" rather than RLS
--   for the main tables. RLS is enabled with open policies only
--   on the two push tables (to match the original migration).
--   If you want stricter access, layer RLS on yourself.
-- ============================================================

-- ===== Players =====
-- Mirrors PLAYERS in src/tournament.config.js. Seed manually after
-- editing the config so DB and client agree on who exists.
create table if not exists players (
  id        text primary key,
  name      text not null,
  emoji     text not null,
  initials  text
);

-- ===== Rounds =====
-- One row per round in the trip. The `format` column drives the
-- scoring engine in src/App.jsx — keep it in sync with the
-- (display-only) format label in ROUNDS in tournament.config.js.
create table if not exists rounds (
  id             int primary key,
  name           text not null,
  format         text not null check (format in ('individual_stroke', 'best_ball', 'scramble', 'championship')),
  status         text not null default 'active' check (status in ('active', 'complete')),
  scorekeeper_a  text references players(id),
  scorekeeper_b  text references players(id)
);

-- ===== Holes (par + stroke index per round) =====
create table if not exists holes (
  round_id      int  not null references rounds(id) on delete cascade,
  hole          int  not null check (hole between 1 and 18),
  par           int  not null,
  stroke_index  int  not null check (stroke_index between 1 and 18),
  primary key (round_id, hole)
);

-- ===== Round strokes (handicap + 3-some group assignment per round) =====
-- group_assignment is 'A' or 'B' for individual stroke rounds
-- (drives which 3-some a player is in), null for formats that
-- treat the field as one group.
create table if not exists round_strokes (
  round_id          int  not null references rounds(id) on delete cascade,
  player_id         text not null references players(id) on delete cascade,
  handicap          int  not null default 0,
  group_assignment  text check (group_assignment is null or group_assignment ~ '^[A-Z]$'),
  primary key (round_id, player_id)
);

-- ===== Scores (one per player per hole per round) =====
-- For scramble rounds, only the captain's row gets written and
-- holds the team's gross — see CLAUDE.md.
create table if not exists scores (
  id          bigserial primary key,
  round_id    int  not null references rounds(id) on delete cascade,
  player_id   text not null references players(id) on delete cascade,
  hole        int  not null check (hole between 1 and 18),
  gross       int  not null,
  entered_by  text references players(id),
  entered_at  timestamptz default now(),
  unique (round_id, player_id, hole)
);
create index if not exists idx_scores_round on scores(round_id);

-- ===== Round points (computed per round per player) =====
create table if not exists round_points (
  round_id   int     not null references rounds(id) on delete cascade,
  player_id  text    not null references players(id) on delete cascade,
  points     numeric not null default 0,
  primary key (round_id, player_id)
);

-- ===== Messages (trash-talk feed) =====
create table if not exists messages (
  id          bigserial primary key,
  player_id   text not null references players(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_messages_created on messages(created_at desc);

-- ===== Push subscriptions (one row per browser endpoint) =====
create table if not exists push_subscriptions (
  id          bigserial primary key,
  player_id   text references players(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz default now()
);
create index if not exists idx_push_subs_player on push_subscriptions(player_id);

-- ===== Notification events (outbox processed by send-push edge fn) =====
create table if not exists notification_events (
  id            bigserial primary key,
  type          text not null,                       -- 'birdie' | 'eagle' | 'message'
  actor_id      text references players(id),
  payload       jsonb not null,                      -- title/body/tag/url for the SW
  status        text not null default 'pending',     -- pending | sent | failed
  attempts      int  not null default 0,
  last_error    text,
  created_at    timestamptz default now(),
  processed_at  timestamptz
);
create index if not exists idx_notif_pending on notification_events(status, created_at) where status = 'pending';

-- ============================================================
-- Row Level Security (open policies on push tables only)
-- ============================================================
alter table push_subscriptions  enable row level security;
alter table notification_events enable row level security;

drop policy if exists "open" on push_subscriptions;
drop policy if exists "open" on notification_events;
create policy "open" on push_subscriptions  for all using (true) with check (true);
create policy "open" on notification_events for all using (true) with check (true);

-- ============================================================
-- Triggers + functions for push notifications
-- ============================================================

-- On every score insert, check if it's a net birdie or eagle and
-- queue a notification_event with the celebratory text.
create or replace function fn_queue_score_event()
returns trigger language plpgsql as $$
declare
  v_par              int;
  v_stroke_index     int;
  v_handicap         int;
  v_format           text;
  v_field_min        int;
  v_strokes_on_hole  int;
  v_net              int;
  v_diff             int;
  v_player_name      text;
  v_player_emoji     text;
  v_kind             text;
  v_body             text;
  v_strokes_received int;
  v_full_round       int;
  v_remainder        int;
begin
  if tg_op <> 'INSERT' then return new; end if;

  select par, stroke_index into v_par, v_stroke_index
    from holes where round_id = new.round_id and hole = new.hole;
  if v_par is null then return new; end if;

  select format into v_format from rounds where id = new.round_id;

  select handicap into v_handicap from round_strokes
    where round_id = new.round_id and player_id = new.player_id;
  if v_handicap is null then v_handicap := 0; end if;

  if v_format in ('best_ball','scramble','championship') then
    select coalesce(min(handicap), 0) into v_field_min
      from round_strokes where round_id = new.round_id;
  else
    select coalesce(min(handicap), 0) into v_field_min
      from round_strokes
      where round_id = new.round_id
        and group_assignment = (
          select group_assignment from round_strokes
          where round_id = new.round_id and player_id = new.player_id
        );
  end if;

  v_strokes_received := greatest(0, v_handicap - v_field_min);

  if v_stroke_index is null or v_strokes_received <= 0 then
    v_strokes_on_hole := 0;
  else
    v_full_round := v_strokes_received / 18;
    v_remainder  := v_strokes_received % 18;
    v_strokes_on_hole := v_full_round + (case when v_stroke_index <= v_remainder then 1 else 0 end);
  end if;

  v_net  := new.gross - v_strokes_on_hole;
  v_diff := v_net - v_par;

  if v_diff > -1 then return new; end if;

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
      'body',  v_body,
      'tag',   'score-' || new.id,
      'url',   '/'
    )
  );

  return new;
end;
$$;

drop trigger if exists trg_queue_score_event on scores;
create trigger trg_queue_score_event
after insert on scores
for each row execute function fn_queue_score_event();

-- On every message insert, queue a notification_event with the
-- first 140 chars of the trash-talk body.
create or replace function fn_queue_message_event()
returns trigger language plpgsql as $$
declare
  v_player_name  text;
  v_player_emoji text;
  v_body_short   text;
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
      'body',  v_body_short,
      'tag',   'msg-' || new.id,
      'url',   '/'
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_queue_message_event on messages;
create trigger trg_queue_message_event
after insert on messages
for each row execute function fn_queue_message_event();

-- When a notification_event lands, fire an HTTP call to the
-- send-push Edge Function via pg_net. The function fans the
-- payload out to all subscribed browsers via Web Push.
--
-- !! Replace YOUR_PROJECT_REF below with your Supabase project ref. !!
create or replace function fn_dispatch_notification()
returns trigger language plpgsql as $$
begin
  if new.status <> 'pending' then return new; end if;
  perform net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('event_id', new.id)
  );
  return new;
end;
$$;

drop trigger if exists trg_dispatch_notification on notification_events;
create trigger trg_dispatch_notification
after insert on notification_events
for each row execute function fn_dispatch_notification();

-- ============================================================
-- Realtime publication
-- ============================================================
-- The client subscribes to live updates on these tables. Adds
-- are idempotent: re-running this file is safe.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;  -- not running against a Supabase project; skip
  end if;
  for t in select unnest(array['scores','messages','round_points','round_strokes','rounds','push_subscriptions'])
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;
