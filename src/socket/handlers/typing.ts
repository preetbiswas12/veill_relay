import { Server, Socket } from 'socket.io';

interface TypingData {
  recipientId: number;
  isTyping: boolean;
}

interface GroupTypingData {
  groupId: string;
  isTyping: boolean;
}

/**
 * Typing indicators via Socket.IO.
 * Server relays typing state to recipient in real-time.
 */
export function registerTypingHandlers(
  io: Server,
  socket: Socket,
  connectedUsers: Map<number, Set<string>>
): void {
  const userId = socket.data.userId as number;
  const username = socket.data.username as string;

  // 1:1 typing indicator
  socket.on('typing', (data: TypingData) => {
    const { recipientId, isTyping } = data;
    const recipientSockets = connectedUsers.get(recipientId);

    if (recipientSockets) {
      for (const socketId of recipientSockets) {
        io.to(socketId).emit('typing', {
          userId,
          username,
          isTyping,
        });
      }
    }
  });

  // Group typing indicator
  socket.on('typing-group', (data: GroupTypingData) => {
    const { groupId, isTyping } = data;

    // Broadcast to all members of the group room except sender
    socket.to(`group:${groupId}`).emit('typing-group', {
      userId,
      username,
      groupId,
      isTyping,
    });
  });
}
