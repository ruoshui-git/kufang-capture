CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    is_owner INTEGER NOT NULL CHECK (is_owner IN (0, 1)),
    disabled_at TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
);
CREATE TABLE sessions (
    token_sha256 TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) CHECK (user_id <> 'owner'),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    device_label TEXT,
    pairing INTEGER NOT NULL CHECK (pairing IN (0, 1))
);
CREATE INDEX sessions_user_expiry ON sessions(user_id, expires_at);
CREATE TABLE join_codes (
    code_sha256 TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);
CREATE UNIQUE INDEX join_codes_pending_user ON join_codes(user_id) WHERE consumed_at IS NULL;
CREATE TABLE login_attempts (
    kind TEXT NOT NULL CHECK (kind IN ('password', 'join')),
    ip TEXT NOT NULL,
    at TEXT NOT NULL
);
CREATE INDEX login_attempts_kind_ip_at ON login_attempts(kind, ip, at);
CREATE INDEX login_attempts_kind_at ON login_attempts(kind, at);
CREATE INDEX login_attempts_at ON login_attempts(at);
