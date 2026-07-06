/**
 * Quidec FCM Relay Server
 * ─────────────────────
 * Minimal Express server that does ONE thing:
 * receives a notification request → sends FCM push → returns.
 *
 * Zero storage. Zero persistence. Pure passthrough.
 *
 * Memory limit: 300 MB (on Render's 512 MB free tier)
 * If memory exceeds limit, process exits and Render restarts it.
 *
 * Deploy to Render free tier:
 *   Build:  npm install
 *   Start:  node server.js
 *   Plan:   Free (512 MB RAM, 0.1 CPU)
 */

const express = require('express');
const admin = require('firebase-admin');
const app = express();
app.use(express.json({ limit: '1kb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Firebase Admin Init ────────────────────────────────────────────────────
// serviceAccountKey.json is uploaded as a Render secret file
admin.initializeApp({
  credential: admin.credential.cert(require('./octate-wee-firebase-adminsdk-fbsvc-66d6e38c4a.json')),
});

const db = admin.firestore('quidec');

// ─── Memory Limiter (300 MB cap on 512 MB Render container) ─────────────────
const MEMORY_LIMIT_MB = 300;
const MEMORY_CHECK_INTERVAL_MS = 30_000;

setInterval(() => {
  const usedMB = process.memoryUsage().rss / 1024 / 1024;
  if (usedMB > MEMORY_LIMIT_MB) {
    console.error(
      `[MEMORY] Limit exceeded: ${usedMB.toFixed(0)}MB > ${MEMORY_LIMIT_MB}MB. Exiting for restart.`
    );
    process.exit(1); // Render auto-restarts
  }
}, MEMORY_CHECK_INTERVAL_MS);

// ─── Health Check (Render + cron job pings this) ─────────────────────────────
app.get('/', (req, res) => {
  const uptime = process.uptime();
  const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
  res.status(200).json({ ok: true, uptime: `${uptime.toFixed(0)}s`, memory: `${memMB}MB` });
});

// ─── POST /notify — THE ONLY ENDPOINT ────────────────────────────────────────
// Body: { to: "recipientUid", fromName: "Preet", type: "text" | "image" | "video" | "audio" }
// Sends FCM push → returns { sent: true/false } → nothing stored
app.post('/notify', async (req, res) => {
  try {
    const { to, fromName, type } = req.body;

    if (!to || !fromName || !type) {
      return res.status(400).json({ error: 'Missing fields: to, fromName, type required' });
    }

    // Look up recipient's FCM token
    const userDoc = await db.doc(`users/${to}`).get();
    const fcmToken = userDoc.data()?.fcmToken;

    if (!fcmToken) {
      console.log(`[NOTIFY] No FCM token for user ${to}`);
      return res.json({ sent: false, reason: 'no_fcm_token' });
    }

    // Build human-readable notification text
    const typeLabels = {
      text: 'a message',
      image: 'an Image',
      video: 'a Video',
      audio: 'a Voice message',
    };
    const body = `${fromName} sent ${typeLabels[type] || 'a message'}`;

    // Send FCM
    await admin.messaging().send({
      token: fcmToken,
      notification: { title: fromName, body },
      data: { type: `new_${type}`, fromName },
      android: { priority: 'high' },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { 'content-available': 1 } },
      },
    });

    console.log(`[NOTIFY] Sent ${type} notification: ${fromName} → ${to}`);
    return res.json({ sent: true });
  } catch (err) {
    console.error('[NOTIFY] Error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] FCM relay running on port ${PORT}`);
  console.log(`[SERVER] Memory limit: ${MEMORY_LIMIT_MB}MB`);
});
