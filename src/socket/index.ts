import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { config } from '../config.js';
import pool from '../database/pool.js';
import { registerMessagingHandlers } from './handlers/messaging.js';
import { registerCallHandlers } from './handlers/calls.js';
import { registerMediaHandlers } from './handlers/media.js';
import { registerPresenceHandlers } from './handlers/presence.js';
import { registerTypingHandlers } from './handlers/typing.js';
import { logger } from '../utils/logger.js';

// userId → Set<socketId>
const connectedUsers = new Map<number, Set<string>>();
// firebaseUid → numeric userId (reverse lookup for typing, etc.)
const firebaseToUserId = new Map<string, number>();

export function getConnectedUsers() {
  return connectedUsers;
}

export function getFirebaseToUserId() {
  return firebaseToUserId;
}

// ─── Per-Socket Rate Limiter ─────────────────────────────────────────────────
// Prevents a single connected client from flooding the server with events.
// Limits: 60 messages/min, 30 calls/min, 100 reads/min, 30 typing/min.

interface RateBucket {
  count: number;
  resetAt: number;
}

const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  'send-message':     { max: 60,  windowMs: 60_000 },
  'message-delivered':{ max: 100, windowMs: 60_000 },
  'message-read':     { max: 100, windowMs: 60_000 },
  'mark-read':        { max: 100, windowMs: 60_000 },
  'chat-opened':      { max: 100, windowMs: 60_000 },
  'delete-message':   { max: 10,  windowMs: 60_000 },
  'read-receipt':     { max: 100, windowMs: 60_000 },
  'typing-start':     { max: 30,  windowMs: 60_000 },
  'typing-stop':      { max: 30,  windowMs: 60_000 },
  'typing-group-start':{ max: 30, windowMs: 60_000 },
  'typing-group-stop': { max: 30, windowMs: 60_000 },
  'initiate-call':    { max: 10,  windowMs: 60_000 },
  'accept-call':      { max: 30,  windowMs: 60_000 },
  'reject-call':      { max: 30,  windowMs: 60_000 },
  'end-call':         { max: 30,  windowMs: 60_000 },
  'call-toggle-mute': { max: 30,  windowMs: 60_000 },
  'call-toggle-video':{ max: 30,  windowMs: 60_000 },
  'veill-upload':     { max: 10,  windowMs: 60_000 },
  'media-start':      { max: 10,  windowMs: 60_000 },
  'media-chunk':      { max: 200, windowMs: 60_000 },
  'get-pending':      { max: 5,   windowMs: 60_000 },
  'get-online-users': { max: 10,  windowMs: 60_000 },
  'check-online':     { max: 30,  windowMs: 60_000 },
  'get-contacts-status':{ max: 10, windowMs: 60_000 },
  'register-device':  { max: 5,   windowMs: 60_000 },
  'webrtc-signal':    { max: 60,  windowMs: 60_000 },
};

const socketRateLimits = new Map<string, Map<string, RateBucket>>();

function isRateLimited(socketId: string, event: string): boolean {
  const limit = RATE_LIMITS[event];
  if (!limit) return false; // No limit configured — allow

  let socketBuckets = socketRateLimits.get(socketId);
  if (!socketBuckets) {
    socketBuckets = new Map();
    socketRateLimits.set(socketId, socketBuckets);
  }

  const now = Date.now();
  const bucket = socketBuckets.get(event);

  if (!bucket || now > bucket.resetAt) {
    socketBuckets.set(event, { count: 1, resetAt: now + limit.windowMs });
    return false;
  }

  if (bucket.count >= limit.max) return true;
  bucket.count++;
  return false;
}

function cleanupSocketRateLimits(socketId: string) {
  socketRateLimits.delete(socketId);
}

// Periodically clean up stale rate limit entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [socketId, buckets] of socketRateLimits) {
    for (const [event, bucket] of buckets) {
      if (now > bucket.resetAt + 60_000) {
        buckets.delete(event);
      }
    }
    if (buckets.size === 0) {
      socketRateLimits.delete(socketId);
    }
  }
}, 5 * 60 * 1000);

export function setupSocketIO(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigin,
      methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 5e7, // 50MB max buffer size
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

    logger.info('[Socket]', `${username} connected (${socket.id})`);

    // Track connection
    if (!connectedUsers.has(userId)) {
      connectedUsers.set(userId, new Set());
    }
    connectedUsers.get(userId)!.add(socket.id);

    // Track Firebase UID → numeric userId mapping
    const firebaseUid = socket.data.firebaseUid as string;
    if (firebaseUid) {
      firebaseToUserId.set(firebaseUid, userId);
    }

    // Update DB presence
    await pool.query(
      'UPDATE users SET is_online = 1, last_seen_at = datetime(\'now\') WHERE id = ?',
      [userId]
    ).catch(() => {});

    // Broadcast online status to all
    io.emit('user-online', { userId, username, online: true });

    // Join user's personal room
    socket.join(`user:${userId}`);

    // ─── Rate-limited event wrapper ───────────────────────────────────────
    // Wrap the original emit to silently drop events that exceed limits
    const originalEmit = socket.emit.bind(socket);
    socket.emit = function(event: string, ...args: unknown[]) {
      if (isRateLimited(socket.id, event)) {
        logger.warn('[RateLimit]', `${username} rate-limited on '${event}'`);
        return false; // Silently drop — don't crash or disconnect
      }
      return originalEmit(event, ...args);
    } as typeof socket.emit;

    // Register all handlers — all receive firebaseToUserId for UID→numeric conversion
    registerMessagingHandlers(io, socket, connectedUsers, firebaseToUserId);
    registerCallHandlers(io, socket, connectedUsers, firebaseToUserId);
    registerMediaHandlers(io, socket, connectedUsers, firebaseToUserId);
    registerPresenceHandlers(io, socket, connectedUsers, firebaseToUserId);
    registerTypingHandlers(io, socket, connectedUsers, firebaseToUserId);

    // Disconnect
    socket.on('disconnect', async () => {
      logger.info('[Socket]', `${username} disconnected (${socket.id})`);

      const sockets = connectedUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          connectedUsers.delete(userId);
          // Clean up Firebase UID mapping
          if (firebaseUid) {
            firebaseToUserId.delete(firebaseUid);
          }
          await pool.query(
            'UPDATE users SET is_online = 0, last_seen_at = datetime(\'now\') WHERE id = ?',
            [userId]
          ).catch(() => {});
          io.emit('user-online', { userId, username, online: false });
        }
      }

      // Clean up rate limit state
      cleanupSocketRateLimits(socket.id);
    });
  });

  return io;
}
