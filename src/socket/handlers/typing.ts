import { Server, Socket } from 'socket.io';
import pool from '../../database/pool.js';
import { logger } from '../../utils/logger.js';

/**
 * Typing indicators via Socket.IO.
 * Server relays typing state to recipient in real-time.
 *
 * Client emits: `typing-start` / `typing-stop` with `{ to: string }` (Firebase UID)
 * Server relays: `typing-start` / `typing-stop` with `{ from: string, username: string }`
 *
 * Group typing:
 * Client emits: `typing-group-start` / `typing-group-stop` with `{ groupId: string }`
 * Server relays: `typing-group-start` / `typing-group-stop` via room
 */
export function registerTypingHandlers(
  io: Server,
  socket: Socket,
  connectedUsers: Map<number, Set<string>>,
  firebaseToUserId: Map<string, number>,
): void {
  const username = socket.data.username as string;
  const firebaseUid = socket.data.firebaseUid as string;

  // 1:1 typing indicator — client sends { to: firebaseUid }
  socket.on('typing-start', (data: { to: string }) => {
    if (!data.to) return;
    const recipientNumericId = firebaseToUserId.get(data.to);
    if (!recipientNumericId) return;
    const recipientSockets = connectedUsers.get(recipientNumericId);
    if (!recipientSockets) return;
    for (const socketId of recipientSockets) {
      io.to(socketId).emit('typing-start', {
        from: firebaseUid,
        username,
      });
    }
  });

  socket.on('typing-stop', (data: { to: string }) => {
    if (!data.to) return;
    const recipientNumericId = firebaseToUserId.get(data.to);
    if (!recipientNumericId) return;
    const recipientSockets = connectedUsers.get(recipientNumericId);
    if (!recipientSockets) return;
    for (const socketId of recipientSockets) {
      io.to(socketId).emit('typing-stop', {
        from: firebaseUid,
        username,
      });
    }
  });

  // Group typing indicator — validate membership before relaying
  socket.on('typing-group-start', async (data: { groupId: string }) => {
    if (!data.groupId) return;
    try {
      const result = await pool.query(
        `SELECT 1 FROM groups WHERE id = ? AND EXISTS (
          SELECT 1 FROM json_each(members) WHERE json_extract(value, '$.userId') = ?
        )`,
        [data.groupId, firebaseUid]
      );
      if (result.rows.length === 0) return;
      socket.to(`group:${data.groupId}`).emit('typing-group-start', {
        from: firebaseUid,
        username,
        groupId: data.groupId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Typing]', `typing-group-start error: ${msg}`);
    }
  });

  socket.on('typing-group-stop', async (data: { groupId: string }) => {
    if (!data.groupId) return;
    try {
      const result = await pool.query(
        `SELECT 1 FROM groups WHERE id = ? AND EXISTS (
          SELECT 1 FROM json_each(members) WHERE json_extract(value, '$.userId') = ?
        )`,
        [data.groupId, firebaseUid]
      );
      if (result.rows.length === 0) return;
      socket.to(`group:${data.groupId}`).emit('typing-group-stop', {
        from: firebaseUid,
        username,
        groupId: data.groupId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Typing]', `typing-group-stop error: ${msg}`);
    }
  });
}
