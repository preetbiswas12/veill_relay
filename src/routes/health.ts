import { Router, Request, Response } from 'express';
import pool from '../database/pool.js';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
