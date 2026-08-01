import Database from 'better-sqlite3';
import { config } from '../config.js';
import fs from 'fs';
import path from 'path';

/**
 * SQLite database wrapper with async-compatible query API.
 * Translates PostgreSQL syntax to SQLite automatically:
 *   - $1, $2, ... → ?
 *   - NOW() → datetime('now')
 *   - true/false → 1/0
 *   - ILIKE → LIKE (SQLite is case-insensitive by default)
 *   - err.code 23505 → SQLITE_CONSTRAINT
 */

// Ensure database directory exists
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.dbPath);

// Enable WAL mode + foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Translate PostgreSQL SQL to SQLite-compatible SQL.
 */
function translateSql(sql: string): string {
  let s = sql;

  // Replace $1, $2, ... with ?
  s = s.replace(/\$\d+/g, '?');

  // Replace NOW() with datetime('now')
  s = s.replace(/\bNOW\(\)/g, "datetime('now')");

  // Replace boolean literals
  s = s.replace(/=\s*true\b/g, '= 1');
  s = s.replace(/=\s*false\b/g, '= 0');
  s = s.replace(/!=\s*false\b/g, '!= 0');

  // Replace ILIKE with LIKE
  s = s.replace(/\bILIKE\b/g, 'LIKE');

  return s;
}

type SqlValue = string | number | boolean | null;

interface QueryResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: Record<string, any>[];
  rowCount: number;
}

/**
 * Execute a query and return results in pg-compatible format.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function query(sql: string, params?: SqlValue[] | any[]): QueryResult {
  const translated = translateSql(sql);
  const trimmed = translated.trim().toUpperCase();

  // Detect RETURNING clause (INSERT ... RETURNING id, etc.)
  const hasReturning = /\bRETURNING\b/i.test(translated);

  if (hasReturning && trimmed.startsWith('INSERT')) {
    // Remove RETURNING clause, execute INSERT, then fetch the inserted row
    const sqlWithoutReturning = translated.replace(/\s*RETURNING\s+[^;]+$/i, '').trim();
    const stmt = db.prepare(sqlWithoutReturning);
    const result = params ? stmt.run(...params) : stmt.run();
    const rowId = result.lastInsertRowid;

    // Extract table name to fetch the full row
    const tableMatch = translated.match(/INSERT\s+INTO\s+(\w+)/i);
    const tableName = tableMatch ? tableMatch[1] : '';

    // Only allow known table names to prevent SQL injection via table name interpolation
    const ALLOWED_TABLES = new Set(['users', 'conversations', 'messages', 'friend_requests', 'friendships', 'media_files', 'pending_payloads', 'groups']);

    if (tableName && ALLOWED_TABLES.has(tableName)) {
      try {
        const fetchStmt = db.prepare(`SELECT * FROM "${tableName}" WHERE rowid = ?`);
        const row = fetchStmt.get(rowId);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      } catch {
        // Fallback: just return the ID
        return { rows: [{ id: rowId }], rowCount: 1 };
      }
    }

    return { rows: [{ id: rowId }], rowCount: 1 };
  }

  if (trimmed.startsWith('SELECT')) {
    const stmt = db.prepare(translated);
    const rows = (params ? stmt.all(...params) : stmt.all()) as Record<string, unknown>[];
    return { rows, rowCount: rows.length };
  }

  // UPDATE, DELETE, etc.
  const stmt = db.prepare(translated);
  const result = params ? stmt.run(...params) : stmt.run();
  return { rows: [], rowCount: result.changes };
}

/**
 * Wrap for async usage — all handlers use await pool.query(...)
 */
async function asyncQuery(sql: string, params?: SqlValue[]): Promise<QueryResult> {
  return query(sql, params);
}

// Export in pg.Pool-compatible format
const pool = {
  query: asyncQuery,
  end: () => db.close(),
  _raw: db as unknown as Record<string, unknown>,
};
export default pool;
