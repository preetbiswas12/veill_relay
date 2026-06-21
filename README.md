# Quidec FCM Relay Server

Minimal notification relay — receives a signal, sends FCM push, returns. Zero storage.

## API

### `GET /`
Health check. Returns `{ ok: true, uptime, memory }`.

### `POST /notify`
Send FCM push notification.

**Body:**
```json
{
  "to": "recipientUid",
  "fromName": "Preet",
  "type": "text" | "image" | "video" | "audio"
}
```

**Response:**
```json
{ "sent": true }
// or
{ "sent": false, "reason": "no_fcm_token" }
```

## Deploy to Render

1. Push to GitHub
2. Create new Web Service on Render
3. Connect repo, set:
   - **Runtime:** Node
   - **Build:** `npm install`
   - **Start:** `node server.js`
   - **Plan:** Free
4. Add secret file: `serviceAccountKey.json` (from Firebase Console → Service Accounts)
5. Deploy

## Keep Warm (Cron Job)

Render free tier spins down after 15 min inactivity. Set up a cron job to ping `GET /` every 10 minutes:

- **cron-job.org** (free): `*/10 * * * *` → `https://your-app.onrender.com/`
- **UptimeRobot** (free): HTTP monitor every 5 min
