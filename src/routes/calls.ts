import { Router, Request, Response } from 'express';
import { authMiddleware } from '../auth/middleware.js';
import { livekitService } from '../services/livekit.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Generate a LiveKit token for a 1:1 call with E2EE.
 * Both users derive the same encryption key from ECDH key exchange.
 * The key ID is included in the token so participants agree on which key to use.
 */
router.post('/token', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { calleeIdentity } = req.body;
    const callerIdentity = req.auth!.firebaseUid;

    if (!calleeIdentity) {
      return res.status(400).json({ error: 'calleeIdentity required' });
    }

    // Validate calleeIdentity type and length
    if (typeof calleeIdentity !== 'string' || calleeIdentity.length > 128) {
      return res.status(400).json({ error: 'Invalid calleeIdentity' });
    }

    // Deterministic room name — same for both users
    const roomName = livekitService.getRoomName(callerIdentity, calleeIdentity);

    // Deterministic E2EE key ID — participants agree on which encryption key to use
    const e2eeKeyId = livekitService.getE2EEKeyId(callerIdentity, calleeIdentity);

    // Generate tokens for both caller and callee (with E2EE grant)
    const callerToken = livekitService.createCallToken(callerIdentity, roomName, e2eeKeyId);
    const calleeToken = livekitService.createCallToken(calleeIdentity, roomName, e2eeKeyId);

    res.json({
      roomName,
      callerToken,
      calleeToken,
      e2eeKeyId, // Client uses this to derive the encryption key
      wsUrl: config.livekitUrl,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[Calls]', `generate token error: ${msg}`);
    res.status(500).json({ error: 'Failed to generate call token' });
  }
});

/**
 * Generate a token for just one user (for rejoining).
 */
router.post('/token/single', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { roomName, e2eeKeyId } = req.body;
    const identity = req.auth!.firebaseUid;

    if (!roomName) {
      return res.status(400).json({ error: 'roomName required' });
    }

    const token = livekitService.createCallToken(identity, roomName, e2eeKeyId);

    res.json({
      roomName,
      token,
      wsUrl: config.livekitUrl,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[Calls]', `generate single token error: ${msg}`);
    res.status(500).json({ error: 'Failed to generate call token' });
  }
});

export default router;
