CREATE TABLE items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    expiration_date TEXT,
    dimensions TEXT NOT NULL DEFAULT '',
    review_status TEXT NOT NULL CHECK (review_status IN ('draft', 'complete', 'needs_review')),
    revision INTEGER NOT NULL DEFAULT 1,
    field_revisions TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO items(id,title,notes,expiration_date,dimensions,review_status,revision,field_revisions,created_at,updated_at)
SELECT e.id,e.title,e.notes,e.expiration_date,e.dimensions,e.review_status,e.revision,
       (SELECT json_group_object(key,value) FROM json_each(e.field_revisions)
        WHERE key IN ('title','notes','expiration_date','dimensions','review_status')),
       e.created_at,e.updated_at
FROM entries e;

CREATE TABLE entries_new (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id),
    sequence_number INTEGER NOT NULL,
    quantity TEXT,
    unit TEXT NOT NULL DEFAULT '',
    count_detail TEXT NOT NULL DEFAULT '',
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    field_revisions TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(collection_id, sequence_number),
    UNIQUE(collection_id, item_id)
);

INSERT INTO entries_new(id,collection_id,item_id,sequence_number,quantity,unit,count_detail,deleted_at,revision,
                        field_revisions,created_at,updated_at)
SELECT e.id,e.collection_id,e.id,e.sequence_number,e.quantity,e.unit,e.count_detail,e.deleted_at,e.revision,
       (SELECT json_group_object(key,value) FROM json_each(e.field_revisions)
        WHERE key IN ('quantity','unit','count_detail','deleted_at')),
       e.created_at,e.updated_at
FROM entries e;

CREATE TABLE photos_new (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(id),
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

INSERT INTO photos_new(id,item_id,sort_order,original_filename,mime_type,byte_size,width,height,sha256,crc32,
                       captured_at,capture_source,caption,is_cover,deleted_at,revision,field_revisions,created_at,
                       updated_at,stored_at,storage_key,thumb_stored_at)
SELECT p.id,p.entry_id,p.sort_order,p.original_filename,p.mime_type,p.byte_size,p.width,p.height,p.sha256,p.crc32,
       p.captured_at,p.capture_source,p.caption,p.is_cover,p.deleted_at,p.revision,p.field_revisions,p.created_at,
       p.updated_at,p.stored_at,p.storage_key,p.thumb_stored_at
FROM photos p;

DROP TABLE photos;
DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;
ALTER TABLE photos_new RENAME TO photos;

CREATE INDEX entries_collection_sequence_idx ON entries(collection_id, sequence_number);
CREATE INDEX entries_item_idx ON entries(item_id);
CREATE INDEX photos_item_idx ON photos(item_id);

-- Publish every migrated item so devices that pull from an older cursor (or from scratch) receive it.
INSERT INTO changes(entity,entity_id,collection_id,kind) SELECT 'item', id, '', 'upsert' FROM items ORDER BY id;
