import { Router, Request, Response } from 'express';
import { authMiddleware } from '../auth/middleware.js';
import pool from '../database/pool.js';
import { promises as fsPromises } from 'fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const MEDIA_DIR = config.mediaDir;

const router = Router();

/**
 * GET /api/media/:fileId
 * Download a .veill file by ID.
 * Requires authentication — only sender or recipient can access.
 */
router.get('/:fileId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const fileId = req.params.fileId as string;
    const userId = req.auth!.userId;

    const result = await pool.query(
      'SELECT * FROM media_files WHERE file_id = ?',
      [fileId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = result.rows[0];

    // Only sender or recipient can access
    if (file.sender_uid !== userId && file.recipient_uid !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Validate disk_path stays within media directory (prevent path traversal)
    if (!file.disk_path.startsWith(MEDIA_DIR)) {
      logger.warn('[Media]', `Path traversal attempt blocked: ${file.disk_path}`);
      return res.status(403).json({ error: 'Invalid file path' });
    }

    // Read .veill file from disk (async)
    try {
      await fsPromises.access(file.disk_path);
    } catch {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    const fileBuffer = await fsPromises.readFile(file.disk_path);

    // Sanitize filename for Content-Disposition header
    const safeFileName = (file.file_name || fileId).replace(/[^a-zA-Z0-9._-]/g, '_');

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.veill"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.send(fileBuffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[Media]', `download error: ${msg}`);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/media/:fileId
 * Delete a .veill file. Only sender can delete.
 */
router.delete('/:fileId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const fileId = req.params.fileId as string;
    const userId = req.auth!.userId;

    const result = await pool.query(
      'SELECT * FROM media_files WHERE file_id = ?',
      [fileId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = result.rows[0];

    if (file.sender_uid !== userId) {
      return res.status(403).json({ error: 'Only sender can delete' });
    }

    // Delete from disk (async, validate path first)
    try {
      if (file.disk_path.startsWith(MEDIA_DIR)) {
        await fsPromises.unlink(file.disk_path);
      }
    } catch (diskErr: unknown) {
      const msg = diskErr instanceof Error ? diskErr.message : String(diskErr);
      logger.error('[Media]', `Failed to delete .veill from disk: ${msg}`);
    }

    // Delete from DB
    await pool.query('DELETE FROM media_files WHERE file_id = ?', [fileId as string]);

    res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[Media]', `delete error: ${msg}`);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
