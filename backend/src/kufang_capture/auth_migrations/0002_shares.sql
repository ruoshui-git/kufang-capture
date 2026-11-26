CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    token_sha256 TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id),
    collection_id TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_viewed_at TEXT
);
CREATE INDEX shares_user_collection ON shares(user_id, collection_id);
