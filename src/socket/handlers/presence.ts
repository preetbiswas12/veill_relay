import { Server, Socket } from 'socket.io';
import pool from '../../database/pool.js';
import { logger } from '../../utils/logger.js';

/**
 * Presence tracking via Socket.IO.
 * Server emits 'user-online' on connect/disconnect.
 * Clients can request full online list via 'get-online-users'.
 */
export function registerPresenceHandlers(
  io: Server,
  socket: Socket,
  connectedUsers: Map<number, Set<string>>,
  _firebaseToUserId: Map<string, number>
): void {
  const userId = socket.data.userId as number;
  const username = socket.data.username as string;

  // Client requests current online friends (not all users — privacy)
  socket.on('get-online-users', async (dataOrAck?: unknown) => {
    const ack = typeof dataOrAck === 'function' ? dataOrAck : undefined;
    try {
      const result = await pool.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_online, u.last_seen_at
         FROM users u
         INNER JOIN friendships f ON
           (f.user1_id = ? AND f.user2_id = u.id)
           OR (f.user2_id = ? AND f.user1_id = u.id)
         WHERE u.id != ?
         LIMIT 200`,
        [userId, userId, userId]
      );

      ack?.({
        success: true,
        users: result.rows.map((u) => ({
          userId: u.id,
          username: u.username,
          displayName: u.display_name,
          avatarUrl: u.avatar_url,
          isOnline: u.is_online,
          lastSeenAt: u.last_seen_at,
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Presence]', `get-online-users error: ${msg}`);
      ack?.({ success: false, error: 'Failed to fetch online users' });
    }
  });

  // Client registers FCM device token (matches client's 'register-device' event)
  socket.on('register-device', async (data: { token: string; platform?: string; appVersion?: string }) => {
    try {
      if (!data.token) return;

      await pool.query(
        'UPDATE users SET fcm_token = ? WHERE id = ?',
        [data.token, userId]
      );

      logger.info('[Presence]', `FCM token registered for ${username} (platform: ${data.platform || 'unknown'})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Presence]', `register-device error: ${msg}`);
    }
  });

  // ─── Check Online (single user) ──────────────────────────────────────
  socket.on('check-online', async (data: { userId: string }) => {
    try {
      if (!data.userId) return;

      // Client sends Firebase UID — find user by firebase_uid
      const result = await pool.query(
        'SELECT id, is_online, last_seen_at FROM users WHERE firebase_uid = ?',
        [data.userId]
      );

      if (result.rows.length > 0) {
        const u = result.rows[0];
        socket.emit('user-status', {
          userId: data.userId,
          online: u.is_online === 1,
          lastSeen: u.last_seen_at ? new Date(u.last_seen_at).getTime() : null,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Presence]', `check-online error: ${msg}`);
    }
  });

  // ─── Get Contacts Status (bulk) ──────────────────────────────────────
  socket.on('get-contacts-status', async (dataOrAck?: unknown) => {
    const ack = typeof dataOrAck === 'function' ? dataOrAck : undefined;
    try {
      // Get only friends of this user (bidirectional friendship)
      const result = await pool.query(
        `SELECT u.firebase_uid, u.username, u.is_online, u.last_seen_at
         FROM users u
         INNER JOIN friendships f ON
           (f.user1_id = ? AND f.user2_id = u.id)
           OR (f.user2_id = ? AND f.user1_id = u.id)
         WHERE u.id != ?
         LIMIT 200`,
        [userId, userId, userId]
      );

      const contacts: Record<string, { online: boolean; lastSeen?: number; username?: string }> = {};
      for (const u of result.rows) {
        if (u.firebase_uid) {
          contacts[u.firebase_uid] = {
            online: u.is_online === 1,
            lastSeen: u.last_seen_at ? new Date(u.last_seen_at).getTime() : undefined,
            username: u.username,
          };
        }
      }

      // Send via both ack and event for compat
      ack?.({ success: true, contacts });
      socket.emit('contacts-presence', { contacts });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Presence]', `get-contacts-status error: ${msg}`);
      ack?.({ success: false, error: 'Failed to fetch contacts status' });
    }
  });

  // ─── WebRTC Signal Relay ─────────────────────────────────────────────
  socket.on('webrtc-signal', (data: { toUid: string; signalId: string; [key: string]: unknown }) => {
    try {
      const { toUid, signalId, ...signalPayload } = data;
      if (!toUid) return;

      // Relay signal to recipient's socket(s)
      // Find recipient by firebase_uid
      pool.query('SELECT id FROM users WHERE firebase_uid = ?', [toUid])
        .then((result) => {
          if (result.rows.length > 0) {
            const recipientId = result.rows[0].id;
            const recipientSockets = connectedUsers.get(recipientId);
            if (recipientSockets) {
              const senderUid = socket.data.firebaseUid as string;
              for (const socketId of recipientSockets) {
                io.to(socketId).emit('webrtc-signal', {
                  ...signalPayload,
                  signalId,
                  fromUid: senderUid, // Always use server-verified sender identity
                });
              }
            }
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('[Presence]', `webrtc-signal relay error: ${msg}`);
        });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Presence]', `webrtc-signal error: ${msg}`);
    }
  });
}
