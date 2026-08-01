import crypto from 'crypto';
import { config } from '../config.js';

/**
 * LiveKit integration for WebRTC call management with E2E encryption.
 * Server: DGX machine via Cloudflare Tunnel at wss://preetllm.qzz.io
 * Key: devkey / secret
 *
 * E2E Encryption:
 *   LiveKit uses a shared encryption key that all participants must have.
 *   We derive this key from ECDH key exchange (same as message E2EE).
 *   The server NEVER has the encryption key — only participants can decrypt.
 *
 * Token flow:
 *   1. Client requests a token for a specific room
 *   2. Server generates a LiveKit JWT (HS256) with room join permissions
 *   3. Token includes E2EE grant with a key ID (not the key itself)
 *   4. Client connects to LiveKit with the token + local encryption key
 *   5. Both caller and callee use the same room name + encryption key
 */

function base64url(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

/**
 * Generate a LiveKit access token for a user to join a room.
 * Includes E2EE grant — the actual encryption key is derived client-side
 * from ECDH key exchange, so the server never has access to it.
 */
function generateToken(
  identity: string,
  roomName: string,
  e2eeKeyId?: string
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);

  const videoGrant: Record<string, string | boolean> = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  };

  // Add E2EE grant if key ID provided
  // The actual encryption key is derived client-side via ECDH
  // The key ID is just an identifier so participants can agree on which key to use
  if (e2eeKeyId) {
    videoGrant.e2ee = true;
    videoGrant.e2eeKeyId = e2eeKeyId;
  }

  const payload = base64url(JSON.stringify({
    iss: config.livekitApiKey,
    sub: identity,
    iat: now,
    exp: now + 86400, // 24h
    video: videoGrant,
  }));

  const signature = crypto
    .createHmac('sha256', config.livekitApiSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

/**
 * Generate a deterministic room name for a 1:1 call.
 * Both users get the same room name regardless of who initiates.
 */
export function getRoomName(user1Identity: string, user2Identity: string): string {
  const sorted = [user1Identity, user2Identity].sort();
  return `call_${sorted[0]}_${sorted[1]}`;
}

/**
 * Generate a deterministic E2EE key ID for a conversation.
 * Both users compute the same key ID from their user IDs.
 * This tells LiveKit participants which encryption key to use.
 */
export function getE2EEKeyId(user1: string, user2: string): string {
  const sorted = [user1, user2].sort();
  return `e2ee_${sorted[0]}_${sorted[1]}`;
}

/**
 * Generate a LiveKit access token with E2EE support.
 */
export function createCallToken(
  userIdentity: string,
  roomName: string,
  e2eeKeyId?: string
): string {
  return generateToken(userIdentity, roomName, e2eeKeyId);
}

/**
 * Check if LiveKit server is reachable (basic health check).
 */
export async function isLiveKitAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(config.livekitUrl.replace('wss://', 'https://').replace('ws://', 'http://'));
    return resp.ok;
  } catch {
    return false;
  }
}

export const livekitService = {
  createCallToken,
  getRoomName,
  getE2EEKeyId,
  isLiveKitAvailable,
};
