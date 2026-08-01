import { Server, Socket } from 'socket.io';
import pool from '../../database/pool.js';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB max file size
const MAX_CHUNK_COUNT = 1000; // Max chunks per upload to prevent array size bomb
const MEDIA_DIR = config.mediaDir;

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

/** Validate fileId contains only safe characters to prevent path traversal */
function isValidFileId(fileId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(fileId);
}

// ─── In-memory chunk buffer for uploads in progress ─────────────────────────
// Keyed by client fileId — cleared after assembly or cancel.
interface ChunkBuffer {
  chunks: (ArrayBuffer | null)[];
  received: number;
  total: number;
  meta: {
    fileName: string;
    mimeType: string;
    fileSize: number;
    receiverId: string;
    conversationId?: string;
    thumbnail?: string;
    duration?: number;
    width?: number;
    height?: number;
  };
  senderSocketId: string;
  createdAt: number;
}

const chunkBuffers = new Map<string, ChunkBuffer>();

// Periodically clean up stale uploads (>30 min old)
setInterval(() => {
  const now = Date.now();
  for (const [fileId, buf] of chunkBuffers) {
    if (now - buf.createdAt > 30 * 60 * 1000) {
      logger.warn('[Media]', `Stale chunk buffer cleaned up: ${fileId}`);
      chunkBuffers.delete(fileId);
    }
  }
}, 5 * 60 * 1000);

// ─── Types ──────────────────────────────────────────────────────────────────

interface VeillUploadData {
  fileId: string;
  recipientUid: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  /** Base64-encoded .veill file data */
  data: string;
}

interface VeillRequestData {
  fileId: string;
}

interface VeillDeleteData {
  fileId: string;
}

interface MediaStartData {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  chunkCount: number;
  receiverId: string;
  conversationId?: string;
  thumbnail?: string;
  duration?: number;
  width?: number;
  height?: number;
}

interface MediaChunkData {
  fileId: string;
  index: number;
  total: number;
  chunk: ArrayBuffer;
}

interface MediaCancelData {
  fileId: string;
}

interface MediaRequestChunksData {
  fileId: string;
}

/**
 * .veill file relay via Socket.IO.
 * Stores encrypted .veill files on disk; metadata in SQLite.
 * Server NEVER sees plaintext — only encrypted .veill blobs.
 *
 * Flow:
 *   1. Sender encrypts data → .veill file (client-side)
 *   2. Sender uploads .veill blob to server
 *   3. Server stores .veill on disk + metadata in DB
 *   4. Server forwards .veill to recipient in real-time
 *   5. Recipient downloads .veill → decrypts locally
 *   6. After recipient confirms, .veill is deleted from server
 */
export function registerMediaHandlers(
  io: Server,
  socket: Socket,
  connectedUsers: Map<number, Set<string>>,
  firebaseToUserId: Map<string, number>
): void {
  const userId = socket.data.userId as number;

  /**
   * Upload a .veill file (sender → server).
   * Server stores the encrypted blob on disk and forwards to recipient.
   */
  socket.on('veill-upload', async (data: VeillUploadData, ack?: (response: Record<string, unknown>) => void) => {
    try {
      const { fileId, recipientUid, mimeType, fileName, fileSize, data: veillData } = data;

      if (!fileId || !recipientUid || !veillData) {
        ack?.({ success: false, error: 'fileId, recipientUid, and data required' });
        return;
      }

      // Validate fileId to prevent path traversal
      if (!isValidFileId(fileId)) {
        ack?.({ success: false, error: 'Invalid fileId format' });
        return;
      }

      // Validate recipientUid — resolve Firebase UID to numeric ID
      const recipientNum = firebaseToUserId.get(recipientUid);
      if (recipientNum == null) {
        ack?.({ success: false, error: 'Invalid recipientUid — user not connected' });
        return;
      }

      // Decode .veill blob from base64
      const veillBuffer = Buffer.from(veillData, 'base64');

      // Validate file size
      if (veillBuffer.length > MAX_FILE_SIZE) {
        ack?.({ success: false, error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` });
        return;
      }

      // Write .veill file to disk (async to avoid blocking event loop)
      const diskPath = path.join(MEDIA_DIR, `${fileId}.veill`);
      await fsPromises.writeFile(diskPath, veillBuffer);

      // Store metadata in DB
      await pool.query(
        `INSERT INTO media_files (file_id, sender_uid, recipient_uid, mime_type, file_name, file_size, disk_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [fileId, userId, recipientNum, mimeType, fileName, fileSize, diskPath]
      );

      // Forward .veill to recipient in real-time
      const recipientSockets = connectedUsers.get(recipientNum);
      if (recipientSockets && recipientSockets.size > 0) {
        for (const socketId of recipientSockets) {
          io.to(socketId).emit('veill-receive', {
            fileId,
            senderId: userId,
            mimeType,
            fileName,
            fileSize,
            data: veillData, // Forward the encrypted .veill blob
          });
        }
      }

      ack?.({ success: true, fileId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Media]', `veill-upload error: ${msg}`);
      ack?.({ success: false, error: 'Failed to upload .veill file' });
    }
  });

  /**
   * Request a .veill file by ID (recipient asks for a specific file).
   */
  socket.on('veill-request', async (data: VeillRequestData) => {
    try {
      const { fileId } = data;

      if (!fileId || !isValidFileId(fileId)) {
        socket.emit('veill-error', { fileId, error: 'Invalid fileId' });
        return;
      }

      const result = await pool.query(
        'SELECT * FROM media_files WHERE file_id = ?',
        [fileId]
      );

      if (result.rows.length === 0) {
        socket.emit('veill-error', { fileId, error: 'File not found' });
        return;
      }

      const file = result.rows[0];

      // Authorization check: only sender or recipient can access the file
      if (file.sender_uid !== userId && file.recipient_uid !== userId) {
        socket.emit('veill-error', { fileId, error: 'Access denied' });
        return;
      }

      // Validate disk_path stays within media directory (prevent path traversal)
      if (!file.disk_path.startsWith(MEDIA_DIR)) {
        logger.warn('[Media]', `Path traversal attempt blocked: ${file.disk_path}`);
        socket.emit('veill-error', { fileId, error: 'Invalid file path' });
        return;
      }

      // Read .veill blob from disk (async)
      const veillBuffer = await fsPromises.readFile(file.disk_path);
      const veillData = veillBuffer.toString('base64');

      socket.emit('veill-receive', {
        fileId,
        senderId: file.sender_uid,
        mimeType: file.mime_type,
        fileName: file.file_name,
        fileSize: file.file_size,
        data: veillData,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Media]', `veill-request error: ${msg}`);
    }
  });

  /**
   * Delete a .veill file after recipient confirms receipt.
   */
  socket.on('veill-delete', async (data: VeillDeleteData) => {
    try {
      const { fileId } = data;

      if (!fileId || !isValidFileId(fileId)) {
        return;
      }

      // Get file info
      const result = await pool.query(
        'SELECT disk_path, sender_uid, recipient_uid FROM media_files WHERE file_id = ?',
        [fileId]
      );

      if (result.rows.length > 0) {
        const file = result.rows[0];

        // Authorization check: only sender or recipient can delete the file
        if (file.sender_uid !== userId && file.recipient_uid !== userId) {
          return;
        }

        const diskPath = file.disk_path;

        // Delete from disk (async)
        try {
          if (diskPath.startsWith(MEDIA_DIR) && fs.existsSync(diskPath)) {
            await fsPromises.unlink(diskPath);
          }
        } catch (diskErr: unknown) {
          const msg = diskErr instanceof Error ? diskErr.message : String(diskErr);
          logger.error('[Media]', `Failed to delete .veill from disk: ${msg}`);
        }

        // Delete from DB
        await pool.query('DELETE FROM media_files WHERE file_id = ?', [fileId]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Media]', `veill-delete error: ${msg}`);
    }
  });

  // ─── Chunk-based media relay ──────────────────────────────────────────────
  // These handlers support the MediaChunkService protocol for files
  // that are sent in 64KB chunks via Socket.IO binary transfer.

  /**
   * media-start: Sender announces an incoming chunked upload.
   * Server stores metadata, allocates buffer, acknowledges with media-started.
   */
  socket.on('media-start', (data: MediaStartData) => {
    try {
      const { fileId, fileName, mimeType, fileSize, chunkCount, receiverId, conversationId, thumbnail, duration, width, height } = data;

      if (!fileId || !fileName || !chunkCount || !receiverId) {
        socket.emit('media-error', { fileId, error: 'fileId, fileName, chunkCount, and receiverId required' });
        return;
      }

      if (fileSize > MAX_FILE_SIZE) {
        socket.emit('media-error', { fileId, error: `File too large. Maximum ${MAX_FILE_SIZE / 1024 / 1024}MB` });
        return;
      }

      // Cap chunkCount to prevent array size bomb
      if (chunkCount > MAX_CHUNK_COUNT) {
        socket.emit('media-error', { fileId, error: `Too many chunks. Maximum ${MAX_CHUNK_COUNT}` });
        return;
      }

      // Allocate chunk buffer
      chunkBuffers.set(fileId, {
        chunks: new Array(chunkCount).fill(null),
        received: 0,
        total: chunkCount,
        meta: { fileName, mimeType, fileSize, receiverId, conversationId, thumbnail, duration, width, height },
        senderSocketId: socket.id,
        createdAt: Date.now(),
      });

      logger.info('[Media]', `media-start: ${fileName} (${chunkCount} chunks) from ${userId}`);

      // Acknowledge to sender
      socket.emit('media-started', {
        clientFileId: fileId,
        serverFileId: fileId, // We use client ID as server ID for simplicity
        messageId: `media_${userId}_${Date.now()}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Media]', `media-start error: ${msg}`);
      socket.emit('media-error', { fileId: data.fileId, error: 'Failed to start upload' });
    }
  });

  /**
   * media-chunk: Sender sends a single chunk.
   * Server stores it, reports progress, and when all chunks arrive, assembles + relays.
   */
  socket.on('media-chunk', (data: MediaChunkData) => {
    try {
      const { fileId, index, chunk } = data;
      const buffer = chunkBuffers.get(fileId);

      if (!buffer) {
        socket.emit('media-error', { fileId, error: 'No active upload for this fileId — did you send media-start?' });
        return;
      }

      // Auth check: only the original uploader can send chunks
      if (buffer.senderSocketId !== socket.id) {
        logger.warn('[Media]', `media-chunk: socket ${socket.id} is not uploader ${buffer.senderSocketId} — rejected`);
        return;
      }

      if (index < 0 || index >= buffer.total) {
        return;
      }

      // Store chunk (first occurrence wins — ignore duplicates)
      if (buffer.chunks[index] === null) {
        buffer.chunks[index] = chunk;
        buffer.received++;
      }

      // Report progress to sender
      socket.emit('media-chunk-received', {
        fileId,
        index,
        total: buffer.total,
        received: buffer.received,
      });

      // All chunks received — assemble and relay
      if (buffer.received === buffer.total) {
        assembleAndRelay(fileId, buffer, io, connectedUsers, firebaseToUserId, userId, socket.data.username as string)
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('[Media]', `Assembly failed for ${fileId}: ${msg}`);
            socket.emit('media-error', { fileId, error: 'Failed to assemble file' });
            chunkBuffers.delete(fileId);
          });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Media]', `media-chunk error: ${msg}`);
    }
  });

  /**
   * media-cancel: Sender cancels an in-progress upload.
   * Server cleans up the chunk buffer.
   */
  socket.on('media-cancel', (data: MediaCancelData) => {
    try {
      const { fileId } = data;
      const buffer = chunkBuffers.get(fileId);
      if (buffer) {
        // Auth check: only the original uploader can cancel
        if (buffer.senderSocketId !== socket.id) {
          logger.warn('[Media]', `media-cancel: socket ${socket.id} is not uploader ${buffer.senderSocketId} — rejected`);
          return;
        }
        chunkBuffers.delete(fileId);
        logger.info('[Media]', `media-cancel: ${fileId} by ${userId}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Media]', `media-cancel error: ${msg}`);
    }
  });

  /**
   * media-request-chunks: Receiver requests missing chunks.
   * Server tells sender which chunk indices to re-send.
   */
  socket.on('media-request-chunks', (data: MediaRequestChunksData) => {
    try {
      const { fileId } = data;
      const buffer = chunkBuffers.get(fileId);

      if (!buffer) {
        return;
      }

      // Find missing chunks (null entries)
      const missing: number[] = [];
      for (let i = 0; i < buffer.chunks.length; i++) {
        if (buffer.chunks[i] === null) {
          missing.push(i);
        }
      }

      if (missing.length === 0) return;

      // Ask original sender to re-send missing chunks
      io.to(buffer.senderSocketId).emit('media-chunk-request', { fileId, indices: missing });

      logger.info('[Media]', `media-request-chunks: ${fileId}, ${missing.length} missing`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Media]', `media-request-chunks error: ${msg}`);
    }
  });
}

// ─── Assembly helper ────────────────────────────────────────────────────────

/**
 * Assemble chunks into a file, write to disk, store metadata in DB,
 * and relay to recipient.
 */
async function assembleAndRelay(
  fileId: string,
  buffer: ChunkBuffer,
  io: Server,
  connectedUsers: Map<number, Set<string>>,
  firebaseToUserId: Map<string, number>,
  senderUserId: number,
  senderUsername: string,
): Promise<void> {
  const { meta, chunks } = buffer;

  // Merge all chunks into a single Buffer
  const merged = Buffer.concat(chunks.map(c => Buffer.from(c!)));
  const diskPath = path.join(MEDIA_DIR, `${fileId}.bin`);

  await fsPromises.writeFile(diskPath, merged);

  // Resolve recipient Firebase UID → numeric ID
  const recipientNum = firebaseToUserId.get(meta.receiverId);

  // Store metadata in DB
  const recipientUidNum = recipientNum ?? 0;
  await pool.query(
    `INSERT INTO media_files (file_id, sender_uid, recipient_uid, mime_type, file_name, file_size, disk_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fileId, senderUserId, recipientUidNum, meta.mimeType, meta.fileName, meta.fileSize, diskPath]
  );

  logger.info('[Media]', `Assembled ${meta.fileName} (${merged.length} bytes) for ${fileId}`);

  // ─── Notify recipient (media-incoming) ──────────────────────────────────
  if (recipientNum != null) {
    const recipientSockets = connectedUsers.get(recipientNum);
    if (recipientSockets && recipientSockets.size > 0) {
      for (const socketId of recipientSockets) {
        io.to(socketId).emit('media-incoming', {
          fileId,
          clientFileId: fileId,
          fileName: meta.fileName,
          mimeType: meta.mimeType,
          fileSize: meta.fileSize,
          chunkCount: buffer.total,
          senderId: String(senderUserId),
          senderUsername,
          messageId: `media_${senderUserId}_${Date.now()}`,
          thumbnail: meta.thumbnail,
        });
      }
    }
  }

  // ─── Notify sender (media-ready) ────────────────────────────────────────
  io.to(buffer.senderSocketId).emit('media-ready', {
    fileId,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    fileSize: meta.fileSize,
    senderId: String(senderUserId),
    storagePath: diskPath,
  });

  // Clean up buffer
  chunkBuffers.delete(fileId);
}
