import { config } from '../config.js';

/**
 * OpenVidu integration for WebRTC call management.
 * Handles session creation, token generation, and NAT/TURN traversal.
 * Gracefully skips if OPENVIDU_URL is not configured.
 */

let openviduClient: any = null;

async function getClient() {
  if (!config.openviduUrl || !config.openviduSecret) {
    return null;
  }

  if (openviduClient) return openviduClient;

  try {
    // openvidu-node-client v2.x
    const { OpenVidu } = await import('openvidu-node-client');
    openviduClient = new OpenVidu(config.openviduUrl, config.openviduSecret);
    console.log('[OpenVidu] Client initialized');
    return openviduClient;
  } catch (err: any) {
    console.warn('[OpenVidu] Not available:', err.message);
    return null;
  }
}

export interface SessionResult {
  sessionId: string;
  token: string;
  available: boolean;
}

/**
 * Create or join an OpenVidu session and return a token for the user.
 */
export async function createSession(
  sessionId: string,
  userId: string
): Promise<SessionResult> {
  const client = await getClient();

  if (!client) {
    return {
      sessionId,
      token: '',
      available: false,
    };
  }

  try {
    // Get or create session
    let session: any;
    try {
      session = await client.fetchSession(sessionId);
    } catch {
      session = await client.createSession({
        customSessionId: sessionId,
        mediaMode: 'RELAY', // Force server relay for reliability
      });
    }

    // Generate token for this user
    const token = await session.generateToken({
      role: 'PUBLISHER',
      data: JSON.stringify({ userId }),
    });

    return {
      sessionId,
      token,
      available: true,
    };
  } catch (err: any) {
    console.error('[OpenVidu] createSession error:', err.message);
    return {
      sessionId,
      token: '',
      available: false,
    };
  }
}

/**
 * Force-close an OpenVidu session.
 */
export async function closeSession(sessionId: string): Promise<void> {
  const client = await getClient();
  if (!client) return;

  try {
    const session = await client.fetchSession(sessionId);
    await session.close();
    console.log(`[OpenVidu] Session ${sessionId} closed`);
  } catch (err: any) {
    console.warn('[OpenVidu] closeSession error:', err.message);
  }
}

/**
 * Check if OpenVidu is available.
 */
export async function isOpenViduAvailable(): Promise<boolean> {
  const client = await getClient();
  return client !== null;
}

export const openviduService = {
  createSession,
  closeSession,
  isOpenViduAvailable,
};
