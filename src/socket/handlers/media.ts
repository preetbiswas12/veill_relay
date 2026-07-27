import { Server, Socket } from 'socket.io';
import pool from '../../database/pool.js';

interface ChunkData {
  chunkId: string;
  messageId: string;
  recipientUid: string;
  chunkIndex: number;
  totalChunks: number;
  mimeType: string;
  fileName: string;
  fileSize: number;
  /** Base64-encoded chunk data */
  data: string;
}

interface ChunkRequestData {
  messageId: string;
  chunkIndex?: number;
}

interface ChunkDeleteData {
  messageId: string;
}

/**
 * Media chunk relay via Socket.IO binary transfer.
 * Stores metadata in SQLite; chunks are relayed in real-time.
 * Images <2MB and audio <5MB go through here; video >5MB goes via WebRTC data channel.
 */
export function registerMediaHandlers(
  io: Server,
  socket: Socket,
  connectedUsers: Map<number, Set<string>>
): void {
  const userId = socket.data.userId as number;

  // Upload a chunk (sender → server)
  socket.on('chunk-upload', async (data: ChunkData, ack?: (response: any) => void) => {
    try {
      const { chunkId, messageId, recipientUid, chunkIndex, totalChunks, mimeType, fileName, fileSize } = data;

      const storagePath = `chunks/${messageId}/${chunkIndex}`;

      await pool.query(
        `INSERT INTO media_chunks (chunk_id, message_id, sender_uid, recipient_uid, chunk_index, total_chunks, mime_type, file_name, file_size, storage_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [chunkId, messageId, String(userId), recipientUid, chunkIndex, totalChunks, mimeType, fileName, fileSize, storagePath]
      );

      // Forward chunk to recipient in real-time
      const recipientSockets = connectedUsers.get(parseInt(recipientUid));
      if (recipientSockets && recipientSockets.size > 0) {
        for (const socketId of recipientSockets) {
          io.to(socketId).emit('chunk-receive', {
            chunkId,
            messageId,
            senderId: userId,
            chunkIndex,
            totalChunks,
            mimeType,
            fileName,
            fileSize,
            data: data.data,
          });
        }
      }

      ack?.({ success: true, chunkId, chunkIndex });
    } catch (err: any) {
      console.error('[Media] chunk-upload error:', err.message);
      ack?.({ success: false, error: 'Failed to upload chunk' });
    }
  });

  // Request chunks (recipient asks for specific or all chunks)
  socket.on('chunk-request', async (data: ChunkRequestData) => {
    try {
      const { messageId, chunkIndex } = data;

      let query = 'SELECT * FROM media_chunks WHERE message_id = ?';
      const params: any[] = [messageId];

      if (chunkIndex !== undefined) {
        query += ' AND chunk_index = ?';
        params.push(chunkIndex);
      }

      query += ' ORDER BY chunk_index ASC';

      const result = await pool.query(query, params);

      socket.emit('chunk-list', {
        messageId,
        chunks: result.rows.map((row) => ({
          chunkId: row.chunk_id,
          chunkIndex: row.chunk_index,
          totalChunks: row.total_chunks,
          mimeType: row.mime_type,
          fileName: row.file_name,
          fileSize: row.file_size,
        })),
      });
    } catch (err: any) {
      console.error('[Media] chunk-request error:', err.message);
    }
  });

  // Delete chunks after all received
  socket.on('chunk-delete', async (data: ChunkDeleteData) => {
    try {
      const { messageId } = data;
      await pool.query('DELETE FROM media_chunks WHERE message_id = ?', [messageId]);
    } catch (err: any) {
      console.error('[Media] chunk-delete error:', err.message);
    }
  });
}
