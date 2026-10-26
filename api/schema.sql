-- Applied on every start, so everything here has to be idempotent.

-- Site likes and Discord reactions share Discord user IDs as user_id, which
-- makes the primary key the dedupe: one person counts once per image.
CREATE TABLE IF NOT EXISTS likes (
  image_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('site', 'discord')),
  created INTEGER NOT NULL,
  PRIMARY KEY (image_id, user_id)
) WITHOUT ROWID;

-- Soft delete: deleted_by keeps who removed a comment.
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT,
  body TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('site', 'discord')),
  discord_msg_id TEXT,
  created INTEGER NOT NULL,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS comments_image ON comments (image_id);

-- Only the SHA-256 of the cookie value is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT,
  is_staff INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL
);

-- Gallery image -> the Discord post it came from (one post can carry several images).
CREATE TABLE IF NOT EXISTS image_posts (
  image_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL
);

-- Sync cursors and the like.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
