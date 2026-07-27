import db from './pool.js';

/**
 * Database schema — 6 tables for the Veill server (SQLite).
 *
 * 1. users           — Firebase UID ↔ server identity
 * 2. conversations   — 1:1 chat rooms (canonical ordering: user1 < user2)
 * 3. messages        — individual messages with delivery/read status
 * 4. friend_requests — pending friend requests
 * 5. friendships     — bidirectional friend links
 * 6. media_chunks    — temporary chunk storage metadata for relay
 */

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    firebase_uid    TEXT UNIQUE NOT NULL,
    username        TEXT NOT NULL,
    display_name    TEXT DEFAULT '',
    avatar_url      TEXT DEFAULT '',
    fcm_token       TEXT DEFAULT '',
    is_online       INTEGER DEFAULT 0,
    last_seen_at    TEXT DEFAULT (datetime('now')),
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user1_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    UNIQUE (user1_id, user2_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_type    TEXT NOT NULL DEFAULT 'text',
    content         TEXT NOT NULL DEFAULT '',
    media_url       TEXT DEFAULT '',
    temp_id         TEXT DEFAULT '',
    is_deleted      INTEGER DEFAULT 0,
    delivered_at    TEXT,
    read_at         TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

  CREATE TABLE IF NOT EXISTS friend_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE (from_user_id, to_user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status);

  CREATE TABLE IF NOT EXISTS friendships (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user1_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE (user1_id, user2_id)
  );

  CREATE TABLE IF NOT EXISTS media_chunks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id        TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    sender_uid      TEXT NOT NULL,
    recipient_uid   TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL,
    total_chunks    INTEGER NOT NULL,
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_name       TEXT DEFAULT '',
    file_size       INTEGER DEFAULT 0,
    storage_path    TEXT DEFAULT '',
    is_transient    INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now')),
    expires_at      TEXT DEFAULT (datetime('now', '+24 hours'))
  );

  CREATE INDEX IF NOT EXISTS idx_media_chunks_message ON media_chunks(message_id);
  CREATE INDEX IF NOT EXISTS idx_media_chunks_recipient ON media_chunks(recipient_uid);
`;

export async function migrate(): Promise<void> {
  try {
    const statements = MIGRATION_SQL.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        db.query(stmt.trim());
      }
    }
    console.log('[DB] Migration complete — all tables ready (SQLite)');
  } catch (err) {
    console.error('[DB] Migration failed:', err);
    throw err;
  }
}

// Run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
