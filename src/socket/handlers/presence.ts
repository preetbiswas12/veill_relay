import { Server, Socket } from 'socket.io';
import pool from '../../database/pool.js';

/**
 * Presence tracking via Socket.IO.
 * Server emits 'user-online' on connect/disconnect.
 * Clients can request full online list via 'get-online-users'.
 */
export function registerPresenceHandlers(
  io: Server,
  socket: Socket,
  connectedUsers: Map<number, Set<string>>
): void {
  const userId = socket.data.userId as number;
  const username = socket.data.username as string;

  // Client requests current online users
  socket.on('get-online-users', async (ack?: (response: any) => void) => {
    try {
      const result = await pool.query(
        'SELECT id, username, display_name, avatar_url, is_online, last_seen_at FROM users WHERE is_online = 1'
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
    } catch (err: any) {
      console.error('[Presence] get-online-users error:', err.message);
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

      console.log(`[Presence] FCM token registered for ${username} (platform: ${data.platform || 'unknown'})`);
    } catch (err: any) {
      console.error('[Presence] register-device error:', err.message);
    }
  });
}
