import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import http from 'http';
import { promises as fsPromises } from 'fs';
import { config } from './config.js';
import { migrate } from './database/migrate.js';
import pool from './database/pool.js';
import { setupSocketIO } from './socket/index.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import callRoutes from './routes/calls.js';
import mediaRoutes from './routes/media.js';
import { logger } from './utils/logger.js';

async function main() {
  // Run database migration
  await migrate();

  const app = express();
  const server = http.createServer(app);

  // Trust first proxy (required for req.ip behind reverse proxy)
  app.set('trust proxy', 1);

  // Security headers
  app.use(helmet());

  // Middleware
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '1mb' }));

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api', healthRoutes);
  app.use('/api/calls', callRoutes);
  app.use('/api/media', mediaRoutes);

  // Root
  app.get('/', (_req, res) => {
    res.json({
      name: 'veill-server',
      version: '2.2.0',
      status: 'running',
      encryption: 'E2EE .veill',
    });
  });

  // Setup Socket.IO
  const io = setupSocketIO(server);
  logger.info('[Socket.IO]', 'Initialized');

  // Cleanup expired .veill files every hour
  const cleanupInterval = setInterval(async () => {
    try {
      const expired = await pool.query(
        'SELECT file_id, disk_path FROM media_files WHERE expires_at < datetime(\'now\')'
      );
      for (const file of expired.rows) {
        try {
          const diskPath = file.disk_path as string;
          // Validate path stays within media directory
          if (diskPath.startsWith(config.mediaDir)) {
            await fsPromises.unlink(diskPath);
          }
        } catch (diskErr: unknown) {
          const msg = diskErr instanceof Error ? diskErr.message : String(diskErr);
          logger.error('[Cleanup]', `Failed to delete file ${file.file_id}: ${msg}`);
        }
      }
      await pool.query('DELETE FROM media_files WHERE expires_at < datetime(\'now\')');
      if (expired.rows.length > 0) {
        logger.info('[Cleanup]', `Removed ${expired.rows.length} expired .veill files`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Cleanup]', `Error during expired file cleanup: ${msg}`);
    }
  }, 3600000); // Every hour

  // Start server
  server.listen(config.port, () => {
    logger.info('[Server]', `Veill server running on port ${config.port}`);
    logger.info('[Server]', 'Database: SQLite (connected)');
    logger.info('[Server]', 'Media: .veill E2EE files');
    logger.info('[Server]', `LiveKit: ${config.livekitUrl}`);
    logger.info('[Server]', `FCM: ${config.firebaseServiceAccount ? 'configured' : 'not configured (optional)'}`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('[Server]', 'Shutting down...');
    clearInterval(cleanupInterval);
    io.close();
    const { default: shutdownPool } = await import('./database/pool.js');
    await shutdownPool.end();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('[Server]', 'Shutting down...');
    clearInterval(cleanupInterval);
    io.close();
    const { default: shutdownPool } = await import('./database/pool.js');
    await shutdownPool.end();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('[Server]', 'Failed to start:', err);
  process.exit(1);
});
