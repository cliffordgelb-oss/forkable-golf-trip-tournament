-- ============================================================
-- Seed: 5 RTJ Trail courses, Purple tees, par + stroke index
-- Run this AFTER the main SETUP.md schema block.
-- ============================================================

-- Update round names with the course identity (display in app)
update rounds set name = 'R1 · Oxmoor Valley, Ridge' where id = 1;
update rounds set name = 'R2 · Ross Bridge' where id = 2;
update rounds set name = 'R3 · Grand National, Lake' where id = 3;
update rounds set name = 'R4 · Grand National, Links' where id = 4;
update rounds set name = 'R5 · Capitol Hill, Senator' where id = 5;

-- Wipe any existing hole data for these rounds before re-seeding (idempotent)
delete from holes where round_id in (1, 2, 3, 4, 5);

-- ===== Round 1: Oxmoor Valley, Ridge Course (Purple) — Par 72 =====
insert into holes (round_id, hole, par, stroke_index) values
  (1,  1, 4,  8),
  (1,  2, 5,  4),
  (1,  3, 5,  2),
  (1,  4, 4, 12),
  (1,  5, 3, 16),
  (1,  6, 4,  6),
  (1,  7, 4, 14),
  (1,  8, 3, 18),
  (1,  9, 4, 10),
  (1, 10, 4,  9),
  (1, 11, 4,  7),
  (1, 12, 5,  3),
  (1, 13, 3, 17),
  (1, 14, 4, 13),
  (1, 15, 4, 11),
  (1, 16, 3, 15),
  (1, 17, 4,  5),
  (1, 18, 5,  1);

-- ===== Round 2: Ross Bridge (Purple) — Par 72 =====
insert into holes (round_id, hole, par, stroke_index) values
  (2,  1, 5,  3),
  (2,  2, 4, 13),
  (2,  3, 4,  1),
  (2,  4, 3, 15),
  (2,  5, 4,  7),
  (2,  6, 3, 11),
  (2,  7, 5,  5),
  (2,  8, 4, 17),
  (2,  9, 4,  9),
  (2, 10, 4,  2),
  (2, 11, 3, 16),
  (2, 12, 4, 18),
  (2, 13, 5,  6),
  (2, 14, 3, 14),
  (2, 15, 4, 12),
  (2, 16, 5,  8),
  (2, 17, 4, 10),
  (2, 18, 4,  4);

-- ===== Round 3: Grand National, Lake Course (Purple) — Par 72 =====
insert into holes (round_id, hole, par, stroke_index) values
  (3,  1, 4, 11),
  (3,  2, 4,  1),
  (3,  3, 3, 15),
  (3,  4, 5,  9),
  (3,  5, 4,  5),
  (3,  6, 4, 13),
  (3,  7, 5,  3),
  (3,  8, 3, 17),
  (3,  9, 4,  7),
  (3, 10, 4,  4),
  (3, 11, 4, 16),
  (3, 12, 5, 12),
  (3, 13, 4,  2),
  (3, 14, 5,  8),
  (3, 15, 3,  6),
  (3, 16, 4, 14),
  (3, 17, 3, 18),
  (3, 18, 4, 10);

-- ===== Round 4: Grand National, Links Course (Purple) — Par 72 =====
insert into holes (round_id, hole, par, stroke_index) values
  (4,  1, 4,  7),
  (4,  2, 5,  5),
  (4,  3, 3, 15),
  (4,  4, 4,  9),
  (4,  5, 4, 11),
  (4,  6, 5,  3),
  (4,  7, 4,  1),
  (4,  8, 4, 13),
  (4,  9, 3, 17),
  (4, 10, 4, 16),
  (4, 11, 3,  8),
  (4, 12, 5,  4),
  (4, 13, 4, 12),
  (4, 14, 4,  6),
  (4, 15, 5, 10),
  (4, 16, 3, 18),
  (4, 17, 4, 14),
  (4, 18, 4,  2);

-- ===== Round 5: Capitol Hill, Senator Course (Purple) — Par 72 =====
insert into holes (round_id, hole, par, stroke_index) values
  (5,  1, 4, 11),
  (5,  2, 3, 17),
  (5,  3, 4, 13),
  (5,  4, 4,  5),
  (5,  5, 5,  1),
  (5,  6, 4,  7),
  (5,  7, 3, 15),
  (5,  8, 5,  3),
  (5,  9, 4,  9),
  (5, 10, 5,  4),
  (5, 11, 4, 14),
  (5, 12, 4,  6),
  (5, 13, 3, 18),
  (5, 14, 4, 12),
  (5, 15, 4,  8),
  (5, 16, 3, 16),
  (5, 17, 5,  2),
  (5, 18, 4, 10);
