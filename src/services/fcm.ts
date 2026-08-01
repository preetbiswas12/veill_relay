import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * FCM push notification service.
 *
 * CRITICAL SECURITY: This service sends SILENT push notifications only.
 * No plaintext message content is ever included in push notifications.
 * The client decrypts locally and shows its own local notification.
 *
 * Flow:
 *   1. Server sends silent push (data-only, no notification payload)
 *   2. Client receives background data message
 *   3. Client decrypts payload locally with ECDH key
 *   4. Client shows local notification with decrypted content
 *
 * This means anyone looking at FCM traffic sees only opaque data fields —
 * never message content, sender names, or any PII beyond routing IDs.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let firebaseApp: { messaging: () => any } | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let messaging: { send: (msg: Record<string, unknown>) => Promise<unknown> } | null = null;

async function getMessaging() {
  if (messaging) return messaging;

  if (!config.firebaseServiceAccount) {
    return null;
  }

  try {
    const admin = await import('firebase-admin');

    if (!firebaseApp) {
      const serviceAccount = JSON.parse(config.firebaseServiceAccount);
      firebaseApp = admin.default.initializeApp({
        credential: admin.default.credential.cert(serviceAccount),
      }) as unknown as { messaging: () => typeof messaging };
    }

    messaging = firebaseApp.messaging();
    return messaging;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[FCM]', `Not available: ${msg}`);
    return null;
  }
}

export interface SilentPushData {
  type: string;          // 'new-message' | 'call' | 'receipt' | 'key-rotate'
  [key: string]: string; // Additional opaque data fields
}

export interface SendPushResult {
  success: boolean;
  error?: string;
}

/**
 * Send a SILENT push notification (data-only, no plaintext).
 *
 * The payload contains only opaque routing data:
 *   - type: what kind of event (new-message, call, receipt)
 *   - messageId: server-assigned ID (not content)
 *   - senderId: numeric ID (not name)
 *   - payloadHash: SHA-256 for integrity
 *
 * The client receives this in background, decrypts the actual message
 * from the server, and shows its own local notification.
 */
export async function sendSilentPush(
  fcmToken: string,
  data: SilentPushData
): Promise<SendPushResult> {
  const msg = await getMessaging();

  if (!msg) {
    return { success: false, error: 'FCM not configured' };
  }

  try {
    // Silent push: data-only, NO notification payload
    // iOS: triggers background fetch via content-available
    // Android: triggers onMessageReceived in background service
    await msg.send({
      token: fcmToken,
      data,  // Only data fields — no notification.title/body
      android: {
        priority: 'high' as const,
      },
      apns: {
        payload: {
          aps: {
            'content-available': 1,  // iOS background fetch trigger
            // NO sound, NO alert — truly silent
          },
        },
      },
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[FCM]', `sendSilentPush error: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Send silent push for a new message.
 * The client will decrypt the actual message content locally.
 */
export async function sendMessagePush(
  fcmToken: string,
  senderId: string,
  messageId: string,
  payloadHash: string,
  contentType: string
): Promise<SendPushResult> {
  return sendSilentPush(fcmToken, {
    type: 'new-message',
    senderId,
    messageId,
    payloadHash,
    contentType,
  });
}

/**
 * Send silent push for an incoming call.
 * The client will show the call UI locally.
 */
export async function sendCallPush(
  fcmToken: string,
  callerId: string,
  callType: 'voice' | 'video'
): Promise<SendPushResult> {
  return sendSilentPush(fcmToken, {
    type: 'call',
    callerId,
    callType,
  });
}

/**
 * Send silent push for a read/delivery receipt.
 */
export async function sendReceiptPush(
  fcmToken: string,
  messageId: string,
  status: 'delivered' | 'read'
): Promise<SendPushResult> {
  return sendSilentPush(fcmToken, {
    type: 'receipt',
    messageId,
    status,
  });
}

export const fcmService = {
  sendSilentPush,
  sendMessagePush,
  sendCallPush,
  sendReceiptPush,
};
