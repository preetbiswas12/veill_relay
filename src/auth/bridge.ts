import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import pool from '../database/pool.js';
import { signToken, AuthPayload } from './middleware.js';

/**
 * Ensures a valid server JWT exists for the given Firebase UID.
 * Flow:
 *   1. Validate stored token via /api/auth/me
 *   2. If invalid → try register with Firebase UID as username
 *   3. If 409 (exists) → login with Firebase UID as username
 */
export async function ensureServerAuth(firebaseUid: string): Promise<string> {
  // Try existing token first from DB
  const existing = await pool.query(
    'SELECT id, firebase_uid, username FROM users WHERE firebase_uid = $1',
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
  const syntheticPassword = `firebase_${firebaseUid}`;
  try {
    const result = await pool.query(
      `INSERT INTO users (firebase_uid, username, display_name)
       VALUES ($1, $2, $3)
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
  } catch (err: any) {
    // 23505 = unique_violation — user already exists, just read it
    if (err.code === '23505') {
      const result = await pool.query(
        'SELECT id, firebase_uid, username FROM users WHERE firebase_uid = $1',
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
