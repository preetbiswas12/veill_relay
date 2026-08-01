import db from './pool.js';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

/**
 * Database schema — 7 tables for the Veill server (SQLite).
 *
 * 1. users             — Firebase UID ↔ server identity
 * 2. conversations     — 1:1 chat rooms (canonical ordering: user1 < user2)
 * 3. messages          — DEPRECATED: kept for backward compat, no new writes
 * 4. friend_requests   — pending friend requests
 * 5. friendships       — bidirectional friend links
 * 6. media_files       — .veill file metadata (encrypted blobs stored on disk)
 * 7. pending_payloads  — encrypted payloads for offline delivery (relay-only)
 *
 * SECURITY MODEL: The server NEVER sees plaintext message content.
 * All message content is encrypted client-side via ECDH + AES-256-GCM.
 * The server only relays opaque encrypted blobs between clients.
 * pending_payloads stores encrypted blobs until the recipient comes online.
 */

// Ensure media directory exists
const mediaDir = path.join(process.cwd(), 'media');
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

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

  CREATE TABLE IF NOT EXISTS media_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id         TEXT UNIQUE NOT NULL,
    sender_uid      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_uid   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_name       TEXT DEFAULT '',
    file_size       INTEGER DEFAULT 0,
    disk_path       TEXT NOT NULL,
    is_transient    INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now')),
    expires_at      TEXT DEFAULT (datetime('now', '+24 hours'))
  );

  CREATE INDEX IF NOT EXISTS idx_media_files_recipient ON media_files(recipient_uid);
  CREATE INDEX IF NOT EXISTS idx_media_files_sender ON media_files(sender_uid);

  -- Pending payloads: encrypted blobs waiting for offline recipients
  -- These are deleted once the recipient fetches them via get-pending
  -- No TTL expiry — they stay until delivered (WhatsApp-like behavior)
  CREATE TABLE IF NOT EXISTS pending_payloads (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id        TEXT NOT NULL,
    sender_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_payload TEXT NOT NULL,       -- Opaque encrypted blob (server cannot decrypt)
    payload_hash      TEXT NOT NULL,       -- SHA-256 of encrypted payload for integrity
    content_type      TEXT NOT NULL DEFAULT 'text',
    temp_id           TEXT DEFAULT '',
    chunk_count       INTEGER DEFAULT 1,
    total_size        INTEGER DEFAULT 0,
    created_at        TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pending_payloads_recipient ON pending_payloads(recipient_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_pending_payloads_message ON pending_payloads(message_id);
`;

export async function migrate(): Promise<void> {
  try {
    const statements = MIGRATION_SQL.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        await db.query(stmt.trim());
      }
    }
    logger.info('[DB]', 'Migration complete — all tables ready (SQLite)');
  } catch (err) {
    logger.error('[DB]', 'Migration failed:', err);
    throw err;
  }
}

// Run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
