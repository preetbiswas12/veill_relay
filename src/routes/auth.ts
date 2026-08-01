import { Router, Request, Response } from 'express';
import pool from '../database/pool.js';
import { authMiddleware, signToken, AuthPayload } from '../auth/middleware.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ─── Firebase ID Token Verification ──────────────────────────────────────────
// Lazily initialized Firebase Admin app — only created when needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let firebaseAdmin: any = null;

async function verifyFirebaseIdToken(idToken: string): Promise<{ uid: string; email?: string; displayName?: string } | null> {
  if (!config.firebaseServiceAccount) {
    // No Firebase configured — skip verification (dev mode)
    logger.warn('[Auth]', 'Firebase Admin not configured — skipping ID token verification');
    return null;
  }

  try {
    if (!firebaseAdmin) {
      const admin = await import('firebase-admin');
      if (!admin.default.apps.length) {
        const serviceAccount = JSON.parse(config.firebaseServiceAccount);
        firebaseAdmin = admin.default.initializeApp({
          credential: admin.default.credential.cert(serviceAccount),
        });
      } else {
        firebaseAdmin = admin.default;
      }
    }

    const decoded = await firebaseAdmin.auth().verifyIdToken(idToken);
    return { uid: decoded.uid, email: decoded.email, displayName: decoded.name };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[Auth]', `Firebase ID token verification failed: ${msg}`);
    return null;
  }
}

// Simple in-memory rate limiter (per-IP)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX_AUTH = 10; // max requests per window for auth endpoints
const RATE_LIMIT_MAX_SEARCH = 20; // max requests per window for search

function rateLimit(ip: string, max = RATE_LIMIT_MAX_AUTH): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

// Register — requires Firebase ID token for identity verification
router.post('/register', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!rateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests, try again later' });
    }

    const { idToken, username, displayName } = req.body;

    if (!idToken || !username) {
      return res.status(400).json({ error: 'idToken and username required' });
    }

    // Validate input types
    if (typeof idToken !== 'string' || typeof username !== 'string') {
      return res.status(400).json({ error: 'Invalid input types' });
    }
    if (username.length > 32 || username.length < 3) {
      return res.status(400).json({ error: 'Username must be 3-32 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    }

    // Verify Firebase ID token — proves the caller owns this Firebase identity
    const firebaseUser = await verifyFirebaseIdToken(idToken);
    if (!firebaseUser) {
      return res.status(401).json({ error: 'Invalid or expired Firebase token' });
    }

    const firebaseUid = firebaseUser.uid;

    const result = await pool.query(
      `INSERT INTO users (firebase_uid, username, display_name)
       VALUES (?, ?, ?)
       RETURNING id, firebase_uid, username, display_name`,
      [firebaseUid, username, displayName || firebaseUser.displayName || username]
    );

    const user = result.rows[0];
    const payload: AuthPayload = {
      userId: user.id,
      firebaseUid: user.firebase_uid,
      username: user.username,
    };

    res.json({
      token: signToken(payload),
      user: {
        id: user.id,
        firebaseUid: user.firebase_uid,
        username: user.username,
        displayName: user.display_name,
      },
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    if ((err as Record<string, unknown>).code === 'SQLITE_CONSTRAINT' || error.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'User already exists' });
    }
    logger.error('[Auth]', `register error: ${error.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login — requires Firebase ID token for identity verification
router.post('/login', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!rateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests, try again later' });
    }

    const { idToken } = req.body;

    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'idToken required' });
    }

    // Verify Firebase ID token — proves the caller owns this Firebase identity
    const firebaseUser = await verifyFirebaseIdToken(idToken);
    if (!firebaseUser) {
      return res.status(401).json({ error: 'Invalid or expired Firebase token' });
    }

    const result = await pool.query(
      'SELECT id, firebase_uid, username, display_name FROM users WHERE firebase_uid = ?',
      [firebaseUser.uid]
    );

    if (result.rows.length === 0) {
      // User not registered yet — tell client to register first
      return res.status(404).json({ error: 'User not registered', code: 'NOT_REGISTERED' });
    }

    const user = result.rows[0];
    const payload: AuthPayload = {
      userId: user.id,
      firebaseUid: user.firebase_uid,
      username: user.username,
    };

    res.json({
      token: signToken(payload),
      user: {
        id: user.id,
        firebaseUid: user.firebase_uid,
        username: user.username,
        displayName: user.display_name,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[Auth]', `login error: ${msg}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify token / get current user
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, firebase_uid, username, display_name, avatar_url, is_online, last_seen_at FROM users WHERE id = ?',
      [req.auth!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      id: user.id,
      firebaseUid: user.firebase_uid,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      isOnline: user.is_online,
      lastSeenAt: user.last_seen_at,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[Auth]', `me error: ${msg}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// Search users
router.get('/search', authMiddleware, async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!rateLimit(ip, RATE_LIMIT_MAX_SEARCH)) {
      return res.status(429).json({ error: 'Too many requests, try again later' });
    }

    const query = req.query.q as string;
    if (!query || query.length < 2) {
      return res.json({ users: [] });
    }

    // Limit query length and sanitize LIKE wildcards
    const sanitizedQuery = query.slice(0, 32).replace(/[%_]/g, '\\$&');

    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, is_online
       FROM users
       WHERE (username LIKE ? ESCAPE '\\' COLLATE NOCASE OR display_name LIKE ? ESCAPE '\\' COLLATE NOCASE)
       ORDER BY username ASC
       LIMIT 20`,
      [`%${sanitizedQuery}%`, `%${sanitizedQuery}%`]
    );

    res.json({
      users: result.rows.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        avatarUrl: u.avatar_url,
        isOnline: u.is_online,
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[Auth]', `search error: ${msg}`);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
