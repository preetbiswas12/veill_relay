import { Server, Socket } from 'socket.io';
import pool from '../../database/pool.js';
import { fcmService } from '../../services/fcm.js';
import crypto from 'crypto';
import { logger } from '../../utils/logger.js';

const MAX_ENCRYPTED_PAYLOAD_LENGTH = 65536; // 64KB max encrypted payload

interface SendMessageData {
  recipientId: number | string;  // Firebase UID (string) or legacy numeric ID
  encryptedPayload: string;   // Client-side encrypted blob (server never decrypts)
  payloadHash: string;        // SHA-256 of encrypted payload for integrity
  contentType: string;        // text | image | video | audio | file
  tempId?: string;
  chunkCount?: number;        // 1 for non-chunked, >1 for media
  totalSize?: number;         // Original unencrypted size
}

interface ReceiptData {
  messageId: string;
  recipientId?: string;       // Firebase UID of recipient (for delivery receipts)
  status: 'delivered' | 'read';
  readBy?: number;            // numeric userId of reader
  conversationId?: string;
  deliveredAt?: number;
  readAt?: number;
}

/**
 * Relay-only messaging handler.
 *
 * The server NEVER stores message content. It only:
 *   1. Relays encrypted payloads to online recipients
 *   2. Temporarily holds encrypted payloads for offline recipients
 *      (deleted once the recipient fetches them)
 *   3. Routes read/delivery receipts (also encrypted)
 *
 * The encryptedPayload is an opaque blob — the server cannot decrypt it.
 * Notifications use silent push (data-only FCM) so the server never
 * sees plaintext message content.
 */
export function registerMessagingHandlers(
  io: Server,
  socket: Socket,
  connectedUsers: Map<number, Set<string>>,
  firebaseToUserId: Map<string, number>
): void {
  const userId = socket.data.userId as number;
  const firebaseUid = socket.data.firebaseUid as string;

  // Helper: resolve recipient — accepts Firebase UID (string) or numeric ID
  function resolveRecipientId(recipientId: number | string): number | null {
    if (typeof recipientId === 'number' && recipientId > 0) return recipientId;
    if (typeof recipientId === 'string' && recipientId.length > 0) {
      const numericId = firebaseToUserId.get(recipientId);
      if (numericId != null) return numericId;
    }
    return null;
  }

  // ─── Send Message (Relay Only) ─────────────────────────────────────────
  socket.on('send-message', async (data: SendMessageData, ack?: (response: Record<string, unknown>) => void) => {
    try {
      const {
        recipientId,
        encryptedPayload,
        payloadHash,
        contentType = 'text',
        tempId = '',
        chunkCount = 1,
        totalSize = 0,
      } = data;

      // --- Input validation ---
      if (!recipientId || !encryptedPayload) {
        ack?.({ success: false, error: 'recipientId and encryptedPayload required' });
        return;
      }

      const resolvedRecipientId = resolveRecipientId(recipientId);
      if (resolvedRecipientId == null) {
        ack?.({ success: false, error: 'Invalid recipientId — could not resolve to numeric ID' });
        return;
      }

      if (typeof encryptedPayload !== 'string' || encryptedPayload.length > MAX_ENCRYPTED_PAYLOAD_LENGTH) {
        ack?.({ success: false, error: `Payload too large. Maximum ${MAX_ENCRYPTED_PAYLOAD_LENGTH} chars` });
        return;
      }

      if (!payloadHash || typeof payloadHash !== 'string') {
        ack?.({ success: false, error: 'payloadHash required (SHA-256 of encrypted payload)' });
        return;
      }

      // Verify payload integrity (timing-safe comparison)
      const computedHash = crypto.createHash('sha256').update(encryptedPayload).digest('hex');
      const hashMatch = crypto.timingSafeEqual(
        Buffer.from(computedHash, 'hex'),
        Buffer.from(payloadHash, 'hex')
      );
      if (!hashMatch) {
        ack?.({ success: false, error: 'Payload integrity check failed' });
        return;
      }

      // Generate a server-assigned message ID (timestamp-based)
      const messageId = `msg_${userId}_${resolvedRecipientId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

      // Update conversation metadata (for contact list ordering)
      const [user1Id, user2Id] = userId < resolvedRecipientId
        ? [userId, resolvedRecipientId]
        : [resolvedRecipientId, userId];

      await pool.query(
        `INSERT INTO conversations (user1_id, user2_id, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT (user1_id, user2_id) DO UPDATE SET updated_at = datetime('now')`,
        [user1Id, user2Id]
      ).catch(() => {});

      // --- Relay to recipient ---
      const recipientSockets = connectedUsers.get(resolvedRecipientId);

      if (recipientSockets && recipientSockets.size > 0) {
        // Recipient online — relay immediately
        for (const socketId of recipientSockets) {
          io.to(socketId).emit('new-message', {
            messageId,
            senderId: userId,
            encryptedPayload,
            payloadHash,
            contentType,
            tempId,
            chunkCount,
            totalSize,
            timestamp: Date.now(),
          });
        }

        // Acknowledge to sender
        ack?.({
          success: true,
          messageId,
          status: 'delivered',
          tempId,
          timestamp: Date.now(),
        });
      } else {
        // Recipient offline — store encrypted payload temporarily
        await pool.query(
          `INSERT INTO pending_payloads (message_id, sender_id, recipient_id, encrypted_payload, payload_hash, content_type, temp_id, chunk_count, total_size)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [messageId, userId, resolvedRecipientId, encryptedPayload, payloadHash, contentType, tempId, chunkCount, totalSize]
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('[Messaging]', `Failed to store pending payload: ${msg}`);
        });

        // Send silent push notification (data-only, NO plaintext)
        try {
          const recipientResult = await pool.query(
            'SELECT fcm_token FROM users WHERE id = ?',
            [resolvedRecipientId]
          );

          if (recipientResult.rows.length > 0 && recipientResult.rows[0].fcm_token) {
            await fcmService.sendSilentPush(
              recipientResult.rows[0].fcm_token,
              {
                type: 'new-message',
                messageId,
                senderId: String(userId),
                payloadHash,
                contentType,
              }
            );
          }
        } catch (fcmErr: unknown) {
          const msg = fcmErr instanceof Error ? fcmErr.message : String(fcmErr);
          logger.error('[Messaging]', `Silent push failed: ${msg}`);
        }

        // Acknowledge to sender (queued, not yet delivered)
        ack?.({
          success: true,
          messageId,
          status: 'queued',
          tempId,
          timestamp: Date.now(),
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Messaging]', `send-message error: ${msg}`);
      ack?.({ success: false, error: 'Failed to send message' });
    }
  });

  // ─── Fetch Pending Payloads (Offline → Online) ─────────────────────────
  socket.on('get-pending', async (ack?: (response: Record<string, unknown>) => void) => {
    try {
      const result = await pool.query(
        `SELECT id, message_id, sender_id, encrypted_payload, payload_hash, content_type, temp_id, chunk_count, total_size, created_at
         FROM pending_payloads
         WHERE recipient_id = ?
         ORDER BY created_at ASC`,
        [userId]
      );

      const pending = result.rows.map((row) => ({
        messageId: row.message_id,
        senderId: row.sender_id,
        encryptedPayload: row.encrypted_payload,
        payloadHash: row.payload_hash,
        contentType: row.content_type,
        tempId: row.temp_id,
        chunkCount: row.chunk_count,
        totalSize: row.total_size,
        timestamp: row.created_at,
      }));

      ack?.({ success: true, messages: pending });

      // Delete delivered payloads (they've been handed to the client)
      if (pending.length > 0) {
        const ids = result.rows.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(',');
        await pool.query(
          `DELETE FROM pending_payloads WHERE id IN (${placeholders})`,
          ids
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('[Messaging]', `Failed to clean pending payloads: ${msg}`);
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Messaging]', `get-pending error: ${msg}`);
      ack?.({ success: false, error: 'Failed to fetch pending messages' });
    }
  });

  // ─── Delete Message (Relay to recipient) ───────────────────────────────
  socket.on('delete-message', async (data: { messageId: string; recipientId: number | string }) => {
    try {
      const { messageId, recipientId } = data;
      const resolvedId = resolveRecipientId(recipientId);

      // Relay delete notification to recipient
      if (resolvedId != null) {
        const recipientSockets = connectedUsers.get(resolvedId);
        if (recipientSockets) {
          for (const socketId of recipientSockets) {
            io.to(socketId).emit('message-deleted', { messageId, deletedBy: userId });
          }
        }
      }

      // Also remove from pending if queued
      await pool.query(
        'DELETE FROM pending_payloads WHERE message_id = ? AND sender_id = ?',
        [messageId, userId]
      ).catch(() => {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Messaging]', `delete-message error: ${msg}`);
    }
  });

  // ─── Read Receipt (Encrypted, Relay Only) ──────────────────────────────
  socket.on('read-receipt', async (data: ReceiptData) => {
    try {
      const { messageId, status } = data;
      if (!data.recipientId) {
        logger.warn('[Messaging]', 'read-receipt missing recipientId — dropped');
        return;
      }
      const resolvedRecipientId = resolveRecipientId(data.recipientId);

      // Relay read receipt to recipient
      if (resolvedRecipientId != null) {
        const recipientSockets = connectedUsers.get(resolvedRecipientId);
        if (recipientSockets) {
          for (const socketId of recipientSockets) {
            io.to(socketId).emit('read-receipt', {
              messageId,
              status,
              readBy: userId,
              timestamp: Date.now(),
            });
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Messaging]', `read-receipt error: ${msg}`);
    }
  });

  // ─── Mark Read (Relay to other party) ──────────────────────────────────
  socket.on('mark-read', async (data: { chatId: string; lastMessageId: string }) => {
    try {
      const { chatId, lastMessageId } = data;

      // chatId format: "firebaseUid1_firebaseUid2" (sorted alphabetically)
      const parts = chatId.split('_');
      if (parts.length !== 2) return;

      const [uid1, uid2] = parts;
      // Validate sender is a participant in this conversation
      if (uid1 !== firebaseUid && uid2 !== firebaseUid) {
        logger.warn('[Messaging]', `mark-read: sender ${firebaseUid} not in chatId ${chatId} — rejected`);
        return;
      }
      const otherFirebaseUid = uid1 === firebaseUid ? uid2 : uid1;
      const otherUserId = firebaseToUserId.get(otherFirebaseUid);

      if (otherUserId != null) {
        const otherSockets = connectedUsers.get(otherUserId);
        if (otherSockets) {
          for (const socketId of otherSockets) {
            io.to(socketId).emit('messages-read', {
              chatId,
              lastMessageId,
              readBy: userId,
              timestamp: Date.now(),
            });
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Messaging]', `mark-read error: ${msg}`);
    }
  });

  // ─── Message Delivered (Relay delivery receipt to sender) ──────────────
  socket.on('message-delivered', async (data: ReceiptData) => {
    try {
      if (!data.recipientId) {
        logger.warn('[Messaging]', 'message-delivered missing recipientId — dropped');
        return;
      }
      const resolvedRecipientId = resolveRecipientId(data.recipientId);
      if (resolvedRecipientId != null) {
        const recipientSockets = connectedUsers.get(resolvedRecipientId);
        if (recipientSockets) {
          for (const socketId of recipientSockets) {
            io.to(socketId).emit('message-delivered', {
              messageId: data.messageId,
              conversationId: data.conversationId,
              deliveredAt: data.deliveredAt || Date.now(),
              readBy: userId,
            });
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Messaging]', `message-delivered error: ${msg}`);
    }
  });

  // ─── Chat Opened (Relay read status to other party) ───────────────────
  socket.on('chat-opened', async (data: { conversationId: string; readerUid: string; messageId?: string; readAt?: number }) => {
    try {
      const { conversationId, messageId, readAt } = data;
      if (!conversationId) return;

      // conversationId format: "firebaseUid1_firebaseUid2" (sorted)
      const parts = conversationId.split('_');
      if (parts.length !== 2) return;

      const [uid1, uid2] = parts;
      // Validate sender is a participant in this conversation
      if (uid1 !== firebaseUid && uid2 !== firebaseUid) {
        logger.warn('[Messaging]', `chat-opened: sender ${firebaseUid} not in conversationId ${conversationId} — rejected`);
        return;
      }
      const otherFirebaseUid = uid1 === firebaseUid ? uid2 : uid1;
      const otherUserId = firebaseToUserId.get(otherFirebaseUid);

      if (otherUserId != null) {
        const otherSockets = connectedUsers.get(otherUserId);
        if (otherSockets) {
          for (const socketId of otherSockets) {
            io.to(socketId).emit('messages-read', {
              chatId: conversationId,
              lastMessageId: messageId || '',
              readBy: userId,
              timestamp: readAt || Date.now(),
            });
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Messaging]', `chat-opened error: ${msg}`);
    }
  });
}
