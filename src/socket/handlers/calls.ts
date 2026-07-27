import { Server, Socket } from 'socket.io';
import pool from '../../database/pool.js';
import { fcmService } from '../../services/fcm.js';

interface CallOfferData {
  recipientId: number;
  callType: 'audio' | 'video';
  offer: RTCSessionDescriptionInit;
}

interface CallAnswerData {
  callerId: number;
  answer: RTCSessionDescriptionInit;
}

interface IceCandidateData {
  targetUserId: number;
  candidate: RTCIceCandidateInit;
}

interface CallEndData {
  targetUserId: number;
  reason?: string;
}

/**
 * WebRTC signaling via Socket.IO.
 * LiveKit handles NAT traversal and relay for actual media.
 * This is the fallback signaling path for direct connections.
 */
export function registerCallHandlers(
  io: Server,
  socket: Socket,
  connectedUsers: Map<number, Set<string>>
): void {
  const userId = socket.data.userId as number;
  const username = socket.data.username as string;

  // Call offer
  socket.on('call-offer', async (data: CallOfferData) => {
    const { recipientId, callType, offer } = data;
    const recipientSockets = connectedUsers.get(recipientId);

    if (!recipientSockets || recipientSockets.size === 0) {
      // Recipient offline — send FCM push for incoming call
      try {
        const recipientResult = await pool.query(
          'SELECT fcm_token, display_name, username FROM users WHERE id = $1',
          [recipientId]
        );

        if (recipientResult.rows.length > 0) {
          const recipient = recipientResult.rows[0];
          if (recipient.fcm_token) {
            const senderResult = await pool.query(
              'SELECT display_name, username FROM users WHERE id = $1',
              [userId]
            );
            const callerName = senderResult.rows.length > 0
              ? senderResult.rows[0].display_name || senderResult.rows[0].username
              : 'Someone';

            await fcmService.sendCallPush(recipient.fcm_token, callerName, callType);
          }
        }
      } catch (fcmErr: any) {
        console.error('[Calls] FCM push failed:', fcmErr.message);
      }

      socket.emit('call-user-offline', { recipientId });
      return;
    }

    for (const socketId of recipientSockets) {
      io.to(socketId).emit('call-offer', {
        callerId: userId,
        callerUsername: username,
        callType,
        offer,
      });
    }

    // Log call attempt
    pool.query(
      `INSERT INTO messages (conversation_id, sender_id, content_type, content)
       VALUES (0, $1, 'call', $2)`,
      [userId, JSON.stringify({ type: 'call-start', callType, target: recipientId })]
    ).catch(() => {});
  });

  // Call answer
  socket.on('call-answer', (data: CallAnswerData) => {
    const { callerId, answer } = data;
    const callerSockets = connectedUsers.get(callerId);

    if (callerSockets) {
      for (const socketId of callerSockets) {
        io.to(socketId).emit('call-answer', {
          answererId: userId,
          answererUsername: username,
          answer,
        });
      }
    }
  });

  // ICE candidate relay
  socket.on('ice-candidate', (data: IceCandidateData) => {
    const { targetUserId, candidate } = data;
    const targetSockets = connectedUsers.get(targetUserId);

    if (targetSockets) {
      for (const socketId of targetSockets) {
        io.to(socketId).emit('ice-candidate', {
          senderId: userId,
          candidate,
        });
      }
    }
  });

  // Call ended
  socket.on('call-end', (data: CallEndData) => {
    const { targetUserId, reason } = data;
    const targetSockets = connectedUsers.get(targetUserId);

    if (targetSockets) {
      for (const socketId of targetSockets) {
        io.to(socketId).emit('call-end', {
          endedBy: userId,
          endedByUsername: username,
          reason: reason || 'ended',
        });
      }
    }
  });

  // Call declined
  socket.on('call-decline', (data: { callerId: number }) => {
    const callerSockets = connectedUsers.get(data.callerId);
    if (callerSockets) {
      for (const socketId of callerSockets) {
        io.to(socketId).emit('call-declined', {
          declinedBy: userId,
          declinedByUsername: username,
        });
      }
    }
  });
}
