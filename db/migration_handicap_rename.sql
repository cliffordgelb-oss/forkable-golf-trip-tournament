-- Rename strokes_received -> handicap.
-- After running this, each player's handicap is an absolute number per round.
-- The app derives group-relative strokes (R1/R3) or field-relative strokes (R2/R4/R5)
-- automatically from the handicaps.

alter table round_strokes rename column strokes_received to handicap;
