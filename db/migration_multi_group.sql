-- Widen round_strokes.group_assignment from 'A'/'B' to any single
-- uppercase letter A-Z, so tournaments with 3+ groups (e.g. 12
-- players in three 4-somes) can use group_assignment = 'C'/'D'/...
--
-- Safe to run on a fresh DB (no-op if the old constraint name
-- doesn't exist) or as an upgrade after migration_two_scorekeepers.

alter table round_strokes
  drop constraint if exists round_strokes_group_assignment_check;

alter table round_strokes
  add constraint round_strokes_group_assignment_check
  check (group_assignment is null or group_assignment ~ '^[A-Z]$');
