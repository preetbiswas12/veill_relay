import { Router, Request, Response } from 'express';
import { authMiddleware } from '../auth/middleware.js';
import { createSession, closeSession } from '../services/openvidu.js';

const router = Router();

// Create or join a call session
router.post('/session', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body;
    const firebaseUid = req.auth!.firebaseUid;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }

    const result = await createSession(sessionId, firebaseUid);

    res.json({
      sessionId: result.sessionId,
      token: result.token,
      available: result.available,
    });
  } catch (err: any) {
    console.error('[Calls] create session error:', err.message);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// End a call session
router.delete('/session/:sessionId', authMiddleware, async (req: Request, res: Response) => {
  try {
    await closeSession(req.params.sessionId);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[Calls] close session error:', err.message);
    res.status(500).json({ error: 'Failed to close session' });
  }
});

export default router;
