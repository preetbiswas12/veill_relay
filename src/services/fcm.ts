import { config } from '../config.js';

/**
 * FCM push notification service.
 * Sends push notifications to offline users via Firebase Cloud Messaging.
 * Uses Firebase Admin SDK with service account credentials.
 */

let firebaseApp: any = null;
let messaging: any = null;

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
      });
    }

    messaging = firebaseApp.messaging();
    console.log('[FCM] Firebase Admin initialized');
    return messaging;
  } catch (err: any) {
    console.warn('[FCM] Not available:', err.message);
    return null;
  }
}

export interface PushPayload {
  fcmToken: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface SendPushResult {
  success: boolean;
  error?: string;
}

/**
 * Send an FCM push notification to a single device.
 */
export async function sendPush(payload: PushPayload): Promise<SendPushResult> {
  const msg = await getMessaging();

  if (!msg) {
    return { success: false, error: 'FCM not configured' };
  }

  try {
    await msg.send({
      token: payload.fcmToken,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data || {},
      android: {
        priority: 'high' as const,
        notification: {
          channelId: 'veill-messages',
          priority: 'high' as const,
        },
      },
      apns: {
        payload: {
          aps: {
            'content-available': 1,
            sound: 'default',
          },
        },
      },
    });

    return { success: true };
  } catch (err: any) {
    console.error('[FCM] sendPush error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send push notification for a new message.
 */
export async function sendMessagePush(
  fcmToken: string,
  senderName: string,
  contentType: string
): Promise<SendPushResult> {
  const typeLabel = contentType === 'text' ? 'Message' :
    contentType === 'image' ? '📷 Photo' :
    contentType === 'video' ? '🎬 Video' :
    contentType === 'audio' ? '🎤 Audio' : 'Message';

  return sendPush({
    fcmToken,
    title: senderName,
    body: `Sent a ${typeLabel.toLowerCase()}`,
    data: {
      type: 'message',
      contentType,
      senderName,
    },
  });
}

/**
 * Send push notification for a call.
 */
export async function sendCallPush(
  fcmToken: string,
  callerName: string,
  callType: 'audio' | 'video'
): Promise<SendPushResult> {
  return sendPush({
    fcmToken,
    title: `${callerName} is calling`,
    body: `Incoming ${callType} call`,
    data: {
      type: 'call',
      callType,
      callerName,
    },
  });
}

export const fcmService = {
  sendPush,
  sendMessagePush,
  sendCallPush,
};
