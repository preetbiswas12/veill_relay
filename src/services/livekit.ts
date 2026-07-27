import crypto from 'crypto';
import { config } from '../config.js';

/**
 * LiveKit integration for WebRTC call management.
 * Server: DGX machine via Cloudflare Tunnel at wss://preetllm.qzz.io
 * Key: devkey / secret
 *
 * Token flow:
 *   1. Client requests a token for a specific room
 *   2. Server generates a LiveKit JWT (HS256) with room join permissions
 *   3. Client connects to LiveKit with the token
 *   4. Both caller and callee use the same room name
 */

function base64url(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

function generateToken(identity: string, roomName: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);

  const payload = base64url(JSON.stringify({
    iss: config.livekitApiKey,
    sub: identity,
    iat: now,
    exp: now + 86400, // 24h
    video: {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  }));

  const signature = crypto
    .createHmac('sha256', config.livekitApiSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

/**
 * Generate a LiveKit access token for a user to join a room.
 */
export function createCallToken(
  userIdentity: string,
  roomName: string
): string {
  return generateToken(userIdentity, roomName);
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
  isLiveKitAvailable,
};
