import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { config } from '../config.js';
import pool from '../database/pool.js';
import { registerMessagingHandlers } from './handlers/messaging.js';
import { registerCallHandlers } from './handlers/calls.js';
import { registerMediaHandlers } from './handlers/media.js';
import { registerPresenceHandlers } from './handlers/presence.js';
import { registerTypingHandlers } from './handlers/typing.js';

// userId → Set<socketId>
const connectedUsers = new Map<number, Set<string>>();

export function getConnectedUsers() {
  return connectedUsers;
}

export function setupSocketIO(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigin,
      methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 1e8, // 100MB for binary chunks
    pingTimeout: 30000,
    pingInterval: 10000,
  });

  // Auth middleware — verify JWT from handshake
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token || typeof token !== 'string') {
        return next(new Error('Authentication required'));
      }

      const jwt = await import('jsonwebtoken');
      const payload = jwt.default.verify(token, config.jwtSecret) as {
        userId: number;
        firebaseUid: string;
        username: string;
      };

      socket.data.userId = payload.userId;
      socket.data.firebaseUid = payload.firebaseUid;
      socket.data.username = payload.username;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const userId = socket.data.userId as number;
    const username = socket.data.username as string;

    console.log(`[Socket] ${username} connected (${socket.id})`);

    // Track connection
    if (!connectedUsers.has(userId)) {
      connectedUsers.set(userId, new Set());
    }
    connectedUsers.get(userId)!.add(socket.id);

    // Update DB presence
    await pool.query(
      'UPDATE users SET is_online = 1, last_seen_at = datetime(\'now\') WHERE id = ?',
      [userId]
    ).catch(() => {});

    // Broadcast online status to all
    io.emit('user-online', { userId, username, online: true });

    // Join user's personal room
    socket.join(`user:${userId}`);

    // Register all handlers
    registerMessagingHandlers(io, socket, connectedUsers);
    registerCallHandlers(io, socket, connectedUsers);
    registerMediaHandlers(io, socket, connectedUsers);
    registerPresenceHandlers(io, socket, connectedUsers);
    registerTypingHandlers(io, socket, connectedUsers);

    // Disconnect
    socket.on('disconnect', async () => {
      console.log(`[Socket] ${username} disconnected (${socket.id})`);

      const sockets = connectedUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          connectedUsers.delete(userId);
          await pool.query(
            'UPDATE users SET is_online = 0, last_seen_at = datetime(\'now\') WHERE id = ?',
            [userId]
          ).catch(() => {});
          io.emit('user-online', { userId, username, online: false });
        }
      }
    });
  });

  return io;
}
