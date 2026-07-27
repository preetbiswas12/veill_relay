import { Router, Request, Response } from 'express';
import pool from '../database/pool.js';
import { isLiveKitAvailable } from '../services/livekit.js';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');

    const livekit = await isLiveKitAvailable();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      livekit: livekit ? 'available' : 'unreachable',
    });
  } catch (err: any) {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'disconnected',
      error: err.message,
    });
  }
});

export default router;
