import { Server, Socket } from 'socket.io';
import pool from '../../database/pool.js';

interface SendMessageData {
  recipientId: number;
  content: string;
  contentType?: string;
  mediaUrl?: string;
  tempId?: string;
}

interface DeleteMessageData {
  messageId: number;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  sender_id: number;
  content_type: string;
  content: string;
  media_url: string;
  temp_id: string;
  is_deleted: boolean;
  created_at: string;
}

/**
 * Canonical conversation ordering: smaller userId is always user1.
 */
function canonicalOrder(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

export function registerMessagingHandlers(
  io: Server,
  socket: Socket,
  connectedUsers: Map<number, Set<string>>
): void {
  const userId = socket.data.userId as number;

  // Send a message
  socket.on('send-message', async (data: SendMessageData, ack?: (response: any) => void) => {
    try {
      const { recipientId, content, contentType = 'text', mediaUrl = '', tempId = '' } = data;

      if (!recipientId || !content) {
        ack?.({ success: false, error: 'recipientId and content required' });
        return;
      }

      // Get or create canonical conversation
      const [user1Id, user2Id] = canonicalOrder(userId, recipientId);

      let convResult = await pool.query(
        'SELECT id FROM conversations WHERE user1_id = $1 AND user2_id = $2',
        [user1Id, user2Id]
      );

      let conversationId: number;
      if (convResult.rows.length === 0) {
        const newConv = await pool.query(
          'INSERT INTO conversations (user1_id, user2_id) VALUES ($1, $2) RETURNING id',
          [user1Id, user2Id]
        );
        conversationId = newConv.rows[0].id;
      } else {
        conversationId = convResult.rows[0].id;
      }

      // Insert message
      const msgResult = await pool.query(
        `INSERT INTO messages (conversation_id, sender_id, content_type, content, media_url, temp_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, conversation_id, sender_id, content_type, content, media_url, temp_id, is_deleted, created_at`,
        [conversationId, userId, contentType, content, mediaUrl, tempId]
      );

      const message: MessageRow = msgResult.rows[0];

      // Update conversation timestamp
      await pool.query(
        'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
        [conversationId]
      ).catch(() => {});

      // Deliver to recipient if online
      const recipientSockets = connectedUsers.get(recipientId);
      if (recipientSockets && recipientSockets.size > 0) {
        for (const socketId of recipientSockets) {
          io.to(socketId).emit('new-message', {
            id: message.id,
            conversationId: message.conversation_id,
            senderId: message.sender_id,
            contentType: message.content_type,
            content: message.content,
            mediaUrl: message.media_url,
            tempId: message.temp_id,
            createdAt: message.created_at,
          });
        }

        // Mark as delivered
        await pool.query(
          'UPDATE messages SET delivered_at = NOW() WHERE id = $1',
          [message.id]
        ).catch(() => {});
      } else {
        // Recipient offline — FCM push handled by the caller (client triggers via REST)
        // Server can also send FCM here if desired
      }

      // Acknowledge to sender
      ack?.({
        success: true,
        message: {
          id: message.id,
          conversationId: message.conversation_id,
          tempId: message.temp_id,
          createdAt: message.created_at,
        },
      });
    } catch (err: any) {
      console.error('[Messaging] send-message error:', err.message);
      ack?.({ success: false, error: 'Failed to send message' });
    }
  });

  // Fetch conversation history
  socket.on('get-messages', async (data: { withUserId: number; before?: number; limit?: number }, ack?: (response: any) => void) => {
    try {
      const { withUserId, before, limit = 50 } = data;
      const [user1Id, user2Id] = canonicalOrder(userId, withUserId);

      const convResult = await pool.query(
        'SELECT id FROM conversations WHERE user1_id = $1 AND user2_id = $2',
        [user1Id, user2Id]
      );

      if (convResult.rows.length === 0) {
        ack?.({ success: true, messages: [] });
        return;
      }

      const conversationId = convResult.rows[0].id;

      let query = `
        SELECT id, conversation_id, sender_id, content_type, content, media_url, temp_id, is_deleted, created_at, read_at
        FROM messages
        WHERE conversation_id = $1 AND is_deleted = false
      `;
      const params: any[] = [conversationId];

      if (before) {
        query += ' AND id < $2';
        params.push(before);
      }

      query += ' ORDER BY created_at DESC';
      query += ` LIMIT ${Math.min(limit, 100)}`;

      const result = await pool.query(query, params);

      ack?.({
        success: true,
        messages: result.rows.reverse().map((m) => ({
          id: m.id,
          conversationId: m.conversation_id,
          senderId: m.sender_id,
          contentType: m.content_type,
          content: m.content,
          mediaUrl: m.media_url,
          tempId: m.temp_id,
          isDeleted: m.is_deleted,
          createdAt: m.created_at,
          readAt: m.read_at,
        })),
      });
    } catch (err: any) {
      console.error('[Messaging] get-messages error:', err.message);
      ack?.({ success: false, error: 'Failed to fetch messages' });
    }
  });

  // Delete a message (soft delete)
  socket.on('delete-message', async (data: DeleteMessageData) => {
    try {
      const { messageId } = data;

      const result = await pool.query(
        'UPDATE messages SET is_deleted = true WHERE id = $1 AND sender_id = $2 RETURNING conversation_id',
        [messageId, userId]
      );

      if (result.rows.length > 0) {
        const conversationId = result.rows[0].conversation_id;

        // Find the other user in the conversation
        const convResult = await pool.query(
          'SELECT user1_id, user2_id FROM conversations WHERE id = $1',
          [conversationId]
        );

        if (convResult.rows.length > 0) {
          const conv = convResult.rows[0];
          const otherUserId = conv.user1_id === userId ? conv.user2_id : conv.user1_id;

          const otherSockets = connectedUsers.get(otherUserId);
          if (otherSockets) {
            for (const socketId of otherSockets) {
              io.to(socketId).emit('message-deleted', { messageId, conversationId });
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[Messaging] delete-message error:', err.message);
    }
  });

  // Mark messages as read
  socket.on('mark-read', async (data: { conversationId: number }) => {
    try {
      const { conversationId } = data;

      await pool.query(
        `UPDATE messages SET read_at = NOW()
         WHERE conversation_id = $1 AND sender_id != $2 AND read_at IS NULL AND is_deleted = false`,
        [conversationId, userId]
      );

      // Notify the other user in the conversation
      const convResult = await pool.query(
        'SELECT user1_id, user2_id FROM conversations WHERE id = $1',
        [conversationId]
      );

      if (convResult.rows.length > 0) {
        const conv = convResult.rows[0];
        const otherUserId = conv.user1_id === userId ? conv.user2_id : conv.user1_id;

        const otherSockets = connectedUsers.get(otherUserId);
        if (otherSockets) {
          for (const socketId of otherSockets) {
            io.to(socketId).emit('messages-read', { conversationId, readBy: userId });
          }
        }
      }
    } catch (err: any) {
      console.error('[Messaging] mark-read error:', err.message);
    }
  });
}
