import { Router, Request, Response } from 'express';
import { authMiddleware } from '../auth/middleware.js';
import { livekitService } from '../services/livekit.js';

const router = Router();

// Generate a LiveKit token for a 1:1 call
router.post('/token', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { calleeIdentity } = req.body;
    const callerIdentity = req.auth!.firebaseUid;

    if (!calleeIdentity) {
      return res.status(400).json({ error: 'calleeIdentity required' });
    }

    // Deterministic room name — same for both users
    const roomName = livekitService.getRoomName(callerIdentity, calleeIdentity);

    // Generate tokens for both caller and callee
    const callerToken = livekitService.createCallToken(callerIdentity, roomName);
    const calleeToken = livekitService.createCallToken(calleeIdentity, roomName);

    res.json({
      roomName,
      callerToken,
      calleeToken,
      wsUrl: process.env.LIVEKIT_URL || 'wss://preetllm.qzz.io',
    });
  } catch (err: any) {
    console.error('[Calls] generate token error:', err.message);
    res.status(500).json({ error: 'Failed to generate call token' });
  }
});

// Generate a token for just one user (for rejoining)
router.post('/token/single', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { roomName } = req.body;
    const identity = req.auth!.firebaseUid;

    if (!roomName) {
      return res.status(400).json({ error: 'roomName required' });
    }

    const token = livekitService.createCallToken(identity, roomName);

    res.json({
      roomName,
      token,
      wsUrl: process.env.LIVEKIT_URL || 'wss://preetllm.qzz.io',
    });
  } catch (err: any) {
    console.error('[Calls] generate single token error:', err.message);
    res.status(500).json({ error: 'Failed to generate call token' });
  }
});

export default router;
