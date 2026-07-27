# Veill Server

Real-time messaging server for the Veill (Quidec) encrypted chat app.

## Stack

- **Socket.IO** — real-time messaging, presence, typing indicators, call signaling
- **PostgreSQL** — conversations, messages, users, friendships, friend requests
- **LiveKit** — WebRTC call management via DGX machine (Cloudflare Tunnel)
- **Firebase Admin** (optional) — FCM push notifications for offline users

## LiveKit Setup

LiveKit Server v1.13.4 runs on the college DGX machine (10.10.224.14):

```bash
cd ~/ml-workspace/preet/livekit
./livekit-server --config livekit.yaml --bind 0.0.0.0 --dev
```

Cloudflare Tunnel proxies WebSocket signaling to `wss://preetllm.qzz.io`.

### LiveKit Config

```yaml
# ~/ml-workspace/preet/livekit/livekit.yaml
port: 7880
tcp_port: 8443
rtc:
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: false
turn:
  enabled: false
keys:
  devkey: secret
```

### How Calls Work

1. Client calls `POST /api/calls/token` with `calleeIdentity`
2. Server generates LiveKit JWT tokens for both users (same room name)
3. Client connects to `wss://preetllm.qzz.io` with the token
4. Both users join the same room - LiveKit handles WebRTC
5. Media flows via TCP port 8443 (college firewall blocks UDP)

## Server Setup

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev    # development
npm run build && npm start   # production
```

## Architecture

### Socket.IO Events

| Event | Direction | Description |
|-------|-----------|-------------|
| send-message | client > server | Send a message |
| new-message | server > client | Receive a message |
| delete-message | client > server | Soft-delete a message |
| message-deleted | server > client | Notification of deletion |
| typing | client <> server | Typing indicator relay |
| user-online | server > client | User online/offline status |
| chunk-upload | client > server | Upload media chunk |
| chunk-receive | server > client | Receive media chunk |

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/register | No | Register user |
| POST | /api/auth/login | No | Login user |
| GET | /api/auth/me | Yes | Get current user |
| GET | /api/auth/search?q= | Yes | Search users |
| POST | /api/calls/token | Yes | Generate LiveKit tokens for caller+callee |
| POST | /api/calls/token/single | Yes | Generate token for one user (rejoin) |
| GET | /api/health | No | Health check |

### Database Tables

1. users - Firebase UID to server identity
2. conversations - 1:1 chat rooms (canonical ordering: user1 < user2)
3. messages - individual messages with delivery/read status
4. friend_requests - pending friend requests
5. friendships - bidirectional friend links
6. media_chunks - temporary chunk storage metadata for relay

## Environment Variables

- DATABASE_URL - PostgreSQL connection string (required)
- JWT_SECRET - Secret for JWT signing (required)
- LIVEKIT_URL - LiveKit WebSocket URL (default: wss://preetllm.qzz.io)
- LIVEKIT_API_KEY - LiveKit API key (default: devkey)
- LIVEKIT_API_SECRET - LiveKit API secret (default: secret)
- FIREBASE_SERVICE_ACCOUNT - Firebase Admin SDK JSON (optional)
- CORS_ORIGIN - Allowed origins (default: *)
