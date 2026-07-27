import express from 'express';
import cors from 'cors';
import http from 'http';
import { config } from './config.js';
import { migrate } from './database/migrate.js';
import { setupSocketIO } from './socket/index.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import callRoutes from './routes/calls.js';

async function main() {
  // Run database migration
  await migrate();

  const app = express();
  const server = http.createServer(app);

  // Middleware
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '10mb' }));

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api', healthRoutes);
  app.use('/api/calls', callRoutes);

  // Root
  app.get('/', (_req, res) => {
    res.json({
      name: 'veill-server',
      version: '2.0.0',
      status: 'running',
    });
  });

  // Setup Socket.IO
  const io = setupSocketIO(server);
  console.log('[Socket.IO] Initialized');

  // Start server
  server.listen(config.port, () => {
    console.log(`[Server] Veill server running on port ${config.port}`);
    console.log(`[Server] Database: connected`);
    console.log(`[Server] LiveKit: ${config.livekitUrl}`);
    console.log(`[Server] FCM: ${config.firebaseServiceAccount ? 'configured' : 'not configured (optional)'}`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    io.close();
    const { default: pool } = await import('./database/pool.js');
    await pool.end();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Server] Shutting down...');
    io.close();
    const { default: pool } = await import('./database/pool.js');
    await pool.end();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[Server] Failed to start:', err);
  process.exit(1);
});
