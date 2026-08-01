import pool from '../database/pool.js';
import { signToken, AuthPayload } from './middleware.js';

/**
 * Ensures a valid server JWT exists for the given Firebase UID.
 *
 * SECURITY: This function trusts the firebaseUid parameter as already verified.
 * It MUST only be called after Firebase token verification (via authMiddleware
 * or verifyFirebaseIdToken in routes/auth.ts). Never call this with raw user input.
 *
 * Flow:
 *   1. Check if user exists in DB
 *   2. If yes → sign token
 *   3. If no → register new user, then sign token
 */
export async function ensureServerAuth(firebaseUid: string): Promise<string> {
  // Try existing user first
  const existing = await pool.query(
    'SELECT id, firebase_uid, username FROM users WHERE firebase_uid = ?',
    [firebaseUid]
  );

  if (existing.rows.length > 0) {
    const user = existing.rows[0];
    const payload: AuthPayload = {
      userId: user.id,
      firebaseUid: user.firebase_uid,
      username: user.username,
    };
    return signToken(payload);
  }

  // Register new user
  try {
    const result = await pool.query(
      `INSERT INTO users (firebase_uid, username, display_name)
       VALUES (?, ?, ?)
       RETURNING id, firebase_uid, username`,
      [firebaseUid, firebaseUid, `User ${firebaseUid.slice(0, 8)}`]
    );

    const user = result.rows[0];
    const payload: AuthPayload = {
      userId: user.id,
      firebaseUid: user.firebase_uid,
      username: user.username,
    };
    return signToken(payload);
  } catch (err: unknown) {
    // SQLite unique constraint error
    const error = err instanceof Error ? err : new Error(String(err));
    if ((err as Record<string, unknown>).code === 'SQLITE_CONSTRAINT' || error.message?.includes('UNIQUE constraint')) {
      const result = await pool.query(
        'SELECT id, firebase_uid, username FROM users WHERE firebase_uid = ?',
        [firebaseUid]
      );
      const user = result.rows[0];
      const payload: AuthPayload = {
        userId: user.id,
        firebaseUid: user.firebase_uid,
        username: user.username,
      };
      return signToken(payload);
    }
    throw err;
  }
}
