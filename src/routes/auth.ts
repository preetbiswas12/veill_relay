import { Router, Request, Response } from 'express';
import pool from '../database/pool.js';
import { authMiddleware, signToken, AuthPayload } from '../auth/middleware.js';

const router = Router();

// Register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { firebaseUid, username, displayName } = req.body;

    if (!firebaseUid || !username) {
      return res.status(400).json({ error: 'firebaseUid and username required' });
    }

    const result = await pool.query(
      `INSERT INTO users (firebase_uid, username, display_name)
       VALUES (?, ?, ?)
       RETURNING id, firebase_uid, username, display_name`,
      [firebaseUid, username, displayName || username]
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
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT' || err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'User already exists' });
    }
    console.error('[Auth] register error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { firebaseUid, username } = req.body;

    if (!firebaseUid) {
      return res.status(400).json({ error: 'firebaseUid required' });
    }

    const result = await pool.query(
      'SELECT id, firebase_uid, username, display_name FROM users WHERE firebase_uid = ?',
      [firebaseUid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found', userNotFound: true });
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
  } catch (err: any) {
    console.error('[Auth] login error:', err.message);
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
  } catch (err: any) {
    console.error('[Auth] me error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Search users
router.get('/search', authMiddleware, async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    if (!query || query.length < 2) {
      return res.json({ users: [] });
    }

    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, is_online
       FROM users
       WHERE username LIKE ? COLLATE NOCASE OR display_name LIKE ? COLLATE NOCASE
       ORDER BY username ASC
       LIMIT 20`,
      [`%${query}%`, `%${query}%`
    ]);

    res.json({
      users: result.rows.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        avatarUrl: u.avatar_url,
        isOnline: u.is_online,
      })),
    });
  } catch (err: any) {
    console.error('[Auth] search error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
