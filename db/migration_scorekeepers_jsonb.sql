-- Migrate from two fixed columns (scorekeeper_a, scorekeeper_b) to a single
-- JSONB map (scorekeepers) that supports any number of groups.
--
-- Before: rounds.scorekeeper_a text, rounds.scorekeeper_b text
-- After:  rounds.scorekeepers jsonb default '{}'
--
-- The new column stores one entry per group letter:
--   {"A": "player_id_for_A", "B": "player_id_for_B", "C": "player_id_for_C", ...}
--
-- Safe to run on an existing install (from migration_two_scorekeepers.sql) or
-- on a fresh install where the column doesn't exist yet.

-- Step 1: add the new column (no-op if already present).
alter table rounds
  add column if not exists scorekeepers jsonb not null default '{}';

-- Step 2: copy existing A/B data into the JSONB column.
-- Builds the object from non-null values only so we don't store null entries.
update rounds
set scorekeepers = (
  select jsonb_object_agg(k, v)
  from (
    values ('A', scorekeeper_a), ('B', scorekeeper_b)
  ) as t(k, v)
  where v is not null
)
where scorekeeper_a is not null or scorekeeper_b is not null;

-- Step 3: drop the old columns.
alter table rounds
  drop column if exists scorekeeper_a,
  drop column if exists scorekeeper_b;
