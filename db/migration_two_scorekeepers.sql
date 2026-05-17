-- Replace single scorekeeper column with one per group.
-- Safe to run on fresh DB or after rounds.scorekeeper has been used (we drop it).

alter table rounds add column if not exists scorekeeper_a text references players(id);
alter table rounds add column if not exists scorekeeper_b text references players(id);
alter table rounds drop column if exists scorekeeper;
