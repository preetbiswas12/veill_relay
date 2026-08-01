import { Server, Socket } from 'socket.io';
import pool from '../../database/pool.js';
import { livekitService } from '../../services/livekit.js';
import { fcmService } from '../../services/fcm.js';
import { logger } from '../../utils/logger.js';

const LIVEKIT_WS_URL = process.env.LIVEKIT_URL || 'wss://preetllm.qzz.io';

interface InitiateCallData {
  receiverId: number | string;  // Firebase UID (string) or legacy numeric ID
  callType: 'voice' | 'video';
}

interface AcceptCallData {
  callId: string;
}

interface RejectCallData {
  callId: string;
}

interface EndCallData {
  callId: string;
  duration?: number;
}

/**
 * Call signaling via Socket.IO for LiveKit E2EE calls.
 *
 * Flow:
 *   1. Caller: emit('initiate-call') → server generates LiveKit tokens + E2EE key ID
 *   2. Server: emit('call-initiated') to caller with tokens
 *   3. Server: emit('incoming-call') to receiver with caller info + E2EE key ID
 *   4. Receiver: emit('accept-call') → server sends tokens to both
 *   5. Both: connect to LiveKit with E2EE enabled
 *   6. End: emit('end-call') → server notifies other party
 *
 * E2EE:
 *   Both users derive the same encryption key from ECDH key exchange.
 *   The key is passed to LiveKit for media encryption.
 *   Server never has the encryption key.
 */
export function registerCallHandlers(
  io: Server,
  socket: Socket,
  connectedUsers: Map<number, Set<string>>,
  firebaseToUserId: Map<string, number>
): void {
  const userId = socket.data.userId as number;
  const username = socket.data.username as string;
  const firebaseUid = socket.data.firebaseUid as string;

  // Helper: resolve receiver — accepts Firebase UID (string) or numeric ID
  function resolveReceiverId(receiverId: number | string): number | null {
    if (typeof receiverId === 'number' && receiverId > 0) return receiverId;
    if (typeof receiverId === 'string' && receiverId.length > 0) {
      const numericId = firebaseToUserId.get(receiverId);
      if (numericId != null) return numericId;
    }
    return null;
  }

  /** Parse callId and validate the caller is a participant */
  function parseCallId(callId: string): { callerId: number; receiverId: number } | null {
    const parts = callId.split('_');
    if (parts.length < 3) return null;
    const callerId = parseInt(parts[1]);
    const receiverId = parseInt(parts[2]);
    if (Number.isNaN(callerId) || Number.isNaN(receiverId)) return null;
    return { callerId, receiverId };
  }

  /**
   * Initiate a call (caller → server).
   * Server generates LiveKit tokens with E2EE and notifies receiver.
   */
  socket.on('initiate-call', async (data: InitiateCallData) => {
    const { receiverId, callType } = data;

    try {
      const resolvedReceiverId = resolveReceiverId(receiverId);
      if (resolvedReceiverId == null) {
        socket.emit('call-error', { error: 'Invalid receiverId — could not resolve' });
        return;
      }

      // Get receiver's Firebase UID for LiveKit identity
      const receiverResult = await pool.query(
        'SELECT firebase_uid, fcm_token, display_name, username FROM users WHERE id = ?',
        [resolvedReceiverId]
      );

      if (receiverResult.rows.length === 0) {
        socket.emit('call-error', { error: 'User not found' });
        return;
      }

      const receiver = receiverResult.rows[0];
      const receiverFirebaseUid = receiver.firebase_uid;

      // Generate LiveKit room + tokens with E2EE
      const roomName = livekitService.getRoomName(firebaseUid, receiverFirebaseUid);
      const e2eeKeyId = livekitService.getE2EEKeyId(firebaseUid, receiverFirebaseUid);
      const callerToken = livekitService.createCallToken(firebaseUid, roomName, e2eeKeyId);
      const calleeToken = livekitService.createCallToken(receiverFirebaseUid, roomName, e2eeKeyId);

      // Generate call ID
      const callId = `call_${userId}_${resolvedReceiverId}_${Date.now()}`;

      // Notify caller that call is initiated
      socket.emit('call-initiated', {
        callId,
        roomName,
        token: callerToken,
        e2eeKeyId,
        wsUrl: LIVEKIT_WS_URL,
      });

      // Notify receiver of incoming call
      const callerName = username || 'Someone';
      const receiverSockets = connectedUsers.get(resolvedReceiverId);

      if (receiverSockets && receiverSockets.size > 0) {
        for (const socketId of receiverSockets) {
          io.to(socketId).emit('incoming-call', {
            callId,
            callerId: userId,
            callerName,
            callType,
            roomName,
            token: calleeToken,
            e2eeKeyId,
            wsUrl: LIVEKIT_WS_URL,
          });
        }
      } else {
        // Receiver is offline — send silent FCM push (no plaintext)
        if (receiver.fcm_token) {
          try {
            await fcmService.sendCallPush(receiver.fcm_token, String(userId), callType);
          } catch (fcmErr: unknown) {
            const msg = fcmErr instanceof Error ? fcmErr.message : String(fcmErr);
            logger.error('[Calls]', `Silent push failed: ${msg}`);
          }
        }
        socket.emit('call-user-offline', { receiverId: resolvedReceiverId });
      }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Calls]', `initiate-call error: ${msg}`);
      socket.emit('call-error', { error: 'Failed to initiate call' });
    }
  });

  /**
   * Accept a call (receiver → server).
   * Server sends LiveKit tokens to both parties.
   */
  socket.on('accept-call', async (data: AcceptCallData) => {
    const { callId } = data;

    try {
      const parsed = parseCallId(callId);
      if (!parsed) {
        socket.emit('call-error', { error: 'Invalid callId format' });
        return;
      }
      const { callerId, receiverId } = parsed;

      // Auth check: only the intended receiver can accept this call
      if (userId !== receiverId) {
        logger.warn('[Calls]', `accept-call: userId ${userId} is not receiver ${receiverId} — rejected`);
        socket.emit('call-error', { error: 'Not authorized to accept this call' });
        return;
      }

      // Get caller's Firebase UID
      const callerResult = await pool.query(
        'SELECT firebase_uid FROM users WHERE id = ?',
        [callerId]
      );

      if (callerResult.rows.length === 0) {
        socket.emit('call-error', { error: 'Caller not found' });
        return;
      }

      const callerFirebaseUid = callerResult.rows[0].firebase_uid;

      // Generate LiveKit room + tokens with E2EE
      const roomName = livekitService.getRoomName(firebaseUid, callerFirebaseUid);
      const e2eeKeyId = livekitService.getE2EEKeyId(firebaseUid, callerFirebaseUid);
      const callerToken = livekitService.createCallToken(callerFirebaseUid, roomName, e2eeKeyId);
      const calleeToken = livekitService.createCallToken(firebaseUid, roomName, e2eeKeyId);

      // Notify caller that call was accepted
      const callerSockets = connectedUsers.get(callerId);
      if (callerSockets) {
        for (const socketId of callerSockets) {
          io.to(socketId).emit('call-accepted', {
            callId,
            roomName,
            token: callerToken,
            e2eeKeyId,
            wsUrl: LIVEKIT_WS_URL,
          });
        }
      }

      // Send token to receiver too
      socket.emit('call-accepted', {
        callId,
        roomName,
        token: calleeToken,
        e2eeKeyId,
        wsUrl: LIVEKIT_WS_URL,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Calls]', `accept-call error: ${msg}`);
      socket.emit('call-error', { error: 'Failed to accept call' });
    }
  });

  /**
   * Reject a call (receiver → server).
   */
  socket.on('reject-call', (data: RejectCallData) => {
    const { callId } = data;

    try {
      const parsed = parseCallId(callId);
      if (!parsed) return;
      const { callerId, receiverId } = parsed;

      // Auth check: only the intended receiver can reject
      if (userId !== receiverId) {
        logger.warn('[Calls]', `reject-call: userId ${userId} is not receiver ${receiverId} — rejected`);
        return;
      }

      const callerSockets = connectedUsers.get(callerId);
      if (callerSockets) {
        for (const socketId of callerSockets) {
          io.to(socketId).emit('call-rejected', { callId });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Calls]', `reject-call error: ${msg}`);
    }
  });

  /**
   * End a call (either party → server).
   */
  socket.on('end-call', (data: EndCallData) => {
    const { callId, duration } = data;

    try {
      const parsed = parseCallId(callId);
      if (!parsed) return;
      const { callerId, receiverId } = parsed;

      // Auth check: only participants can end the call
      if (userId !== callerId && userId !== receiverId) {
        logger.warn('[Calls]', `end-call: userId ${userId} is not a participant — rejected`);
        return;
      }

      // Notify the other party
      const otherUserId = userId === callerId ? receiverId : callerId;
      const otherSockets = connectedUsers.get(otherUserId);

      if (otherSockets) {
        for (const socketId of otherSockets) {
          io.to(socketId).emit('call-ended', { callId, duration, endedBy: userId });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Calls]', `end-call error: ${msg}`);
    }
  });

  /**
   * Toggle mute (for UI sync).
   */
  socket.on('call-toggle-mute', (data: { to: number | string; muted: boolean }) => {
    const resolvedTo = resolveReceiverId(data.to);
    if (resolvedTo == null) return;
    const targetSockets = connectedUsers.get(resolvedTo);
    if (targetSockets) {
      for (const socketId of targetSockets) {
        io.to(socketId).emit('call-toggle-mute', { from: userId, muted: data.muted });
      }
    }
  });

  /**
   * Toggle video (for UI sync).
   */
  socket.on('call-toggle-video', (data: { to: number | string; videoOff: boolean }) => {
    const resolvedTo = resolveReceiverId(data.to);
    if (resolvedTo == null) return;
    const targetSockets = connectedUsers.get(resolvedTo);
    if (targetSockets) {
      for (const socketId of targetSockets) {
        io.to(socketId).emit('call-toggle-video', { from: userId, videoOff: data.videoOff });
      }
    }
  });
}
