-- Keep historical identifiers when a room, entry, or server copy disappears.
-- Sync checks item existence on create and explicitly purges movements on item purge.
CREATE TABLE movements (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    from_entry_id TEXT,
    to_entry_id TEXT,
    from_collection_id TEXT,
    to_collection_id TEXT,
    from_sequence INTEGER NOT NULL,
    to_sequence INTEGER NOT NULL,
    from_name TEXT NOT NULL,
    to_name TEXT NOT NULL,
    quantity TEXT,
    unit TEXT NOT NULL,
    count_detail TEXT NOT NULL,
    target_before_quantity TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('move', 'part', 'merge', 'split')),
    moved_at TEXT NOT NULL,
    undone_at TEXT,
    source TEXT NOT NULL CHECK (source IN ('app', 'text')),
    legacy_text TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    field_revisions TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX movements_item_idx ON movements(item_id);
