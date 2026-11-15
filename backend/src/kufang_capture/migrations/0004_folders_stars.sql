-- Collection folders, per-collection entry notes and per-entry stars. All additive with defaults,
-- so existing rows keep their data and older clients that omit these fields keep working.
ALTER TABLE collections ADD COLUMN folder TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN entry_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN starred_at TEXT;
