# Veill Server

Real-time messaging server for the Veill (Quidec) encrypted chat app.

## Stack

- **Socket.IO** — real-time messaging, presence, typing indicators, call signaling
- **PostgreSQL** — conversations, messages, users, friendships, friend requests
- **OpenVidu** (optional) — WebRTC call management, NAT/TURN traversal
- **Firebase Admin** (optional) — FCM push notifications for offline users

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment
cp .env.example .env
# Edit .env with your PostgreSQL URL, JWT secret, etc.

# 3. Run database migration
npm run migrate

# 4. Start the server
npm run dev    # development (watch mode)
npm run build && npm start   # production
```

## Architecture

### Socket.IO Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `send-message` | client → server | Send a message |
| `new-message` | server → client | Receive a message |
| `delete-message` | client → server | Soft-delete a message |
| `message-deleted` | server → client | Notification of deletion |
| `typing` | client ↔ server | Typing indicator relay |
| `call-offer` | client → server | WebRTC call offer |
| `call-answer` | server → client | WebRTC call answer |
| `ice-candidate` | client ↔ server | ICE candidate relay |
| `call-end` | client → server | End call |
| `user-online` | server → client | User online/offline status |
| `chunk-upload` | client → server | Upload media chunk |
| `chunk-receive` | server → client | Receive media chunk |

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Register user |
| POST | `/api/auth/login` | No | Login user |
| GET | `/api/auth/me` | Yes | Get current user |
| GET | `/api/auth/search?q=` | Yes | Search users |
| POST | `/api/calls/session` | Yes | Create OpenVidu session |
| DELETE | `/api/calls/session/:id` | Yes | Close OpenVidu session |
| GET | `/api/health` | No | Health check |

### Database Tables

1. **users** — Firebase UID ↔ server identity
2. **conversations** — 1:1 chat rooms (canonical ordering: user1 < user2)
3. **messages** — individual messages with delivery/read status
4. **friend_requests** — pending friend requests
5. **friendships** — bidirectional friend links
6. **media_chunks** — temporary chunk storage metadata for relay

## Deployment

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:3000
```

### DGX / Stable Machine

```bash
# Build and start
npm run build
PORT=3000 DATABASE_URL=postgresql://... node dist/server.js
```

## Environment Variables

See `.env.example` for all configuration options.

- `DATABASE_URL` — PostgreSQL connection string (required)
- `JWT_SECRET` — Secret for JWT signing (required)
- `OPENVIDU_URL` / `OPENVIDU_SECRET` — OpenVidu credentials (optional)
- `FIREBASE_SERVICE_ACCOUNT` — Firebase Admin SDK JSON (optional)
- `CORS_ORIGIN` — Allowed origins (default: `*`)
