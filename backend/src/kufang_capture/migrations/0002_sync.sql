CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    storage_mode TEXT NOT NULL CHECK (storage_mode = 'synced'),
    next_sequence_number INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER,
    sync_consented_at TEXT,
    last_exported_at TEXT,
    archived_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    field_revisions TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    quantity TEXT,
    unit TEXT NOT NULL DEFAULT '',
    count_detail TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    expiration_date TEXT,
    dimensions TEXT NOT NULL DEFAULT '',
    review_status TEXT NOT NULL CHECK (review_status IN ('draft', 'complete', 'needs_review')),
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    field_revisions TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(collection_id, sequence_number)
);
CREATE TABLE photos (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    original_filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    sha256 TEXT NOT NULL,
    crc32 INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    capture_source TEXT NOT NULL CHECK (capture_source IN ('native_camera', 'photo_library', 'camera_frame')),
    caption TEXT NOT NULL DEFAULT '',
    is_cover INTEGER NOT NULL DEFAULT 0 CHECK (is_cover IN (0, 1)),
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    field_revisions TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    stored_at TEXT,
    storage_key TEXT,
    thumb_stored_at TEXT
);
CREATE TABLE changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    collection_id TEXT NOT NULL,
    kind TEXT NOT NULL
);
CREATE INDEX changes_seq_idx ON changes(seq);
CREATE INDEX entries_collection_sequence_idx ON entries(collection_id, sequence_number);
CREATE INDEX photos_entry_idx ON photos(entry_id);
CREATE INDEX photos_collection_idx ON photos(collection_id);
CREATE TABLE applied_mutations (
    mutation_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
CREATE TABLE sessions (
    token_sha256 TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE login_attempts (
    ip TEXT NOT NULL,
    at TEXT NOT NULL
);
CREATE INDEX login_attempts_ip_at_idx ON login_attempts(ip, at);
