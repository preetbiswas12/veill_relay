/**
 * DEPRECATED — This relay is superseded by quidec_server/src/services/fcm.ts.
 *
 * The server below is kept for reference only. Do not run in production.
 * FCM push notifications are now sent directly from quidec_server.
 */

const express = require('express');
const app = express();
app.use(express.json({ limit: '1kb' }));

app.get('/', (req, res) => res.status(200).json({
  ok: false,
  deprecated: true,
  message: 'This relay is deprecated. Use quidec_server instead.',
  successor: 'https://github.com/preetbiswas12/quidec_server',
}));

app.post('/notify', (req, res) => {
  res.status(410).json({
    error: 'Deprecated',
    message: 'FCM push is now handled by quidec_server. See https://github.com/preetbiswas12/quidec_server',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚠️  Deprecated relay on :${PORT} — use quidec_server instead`));
