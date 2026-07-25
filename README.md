# quidec-relay (DEPRECATED)

> **This relay is no longer needed.** FCM push notifications are now handled directly by [quidec_server](https://github.com/preetbiswas12/quidec_server) via `src/services/fcm.ts`.

## What changed

- The standalone Express relay (`server.js`) forwarded push notifications through Firebase Admin SDK.
- `quidec_server` now sends FCM push notifications natively — no separate relay process required.
- Socket.IO handles real-time delivery, typing indicators, and presence. FCM handles offline push.

## Migration

1. Stop any running `quidec-relay` instance.
2. Deploy `quidec_server` — it includes FCM push via `FCM_SERVER_KEY` env var.
3. Archive or delete this repo.

## Original usage

```
POST /notify
{
  "to": "<fcm_token>",
  "fromName": "Alice",
  "type": "text" | "image" | "video" | "audio"
}
```

No longer called by the client.
