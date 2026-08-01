import dotenv from 'dotenv';
import path from 'path';
dotenv.config();

function requireEnv(name: string, fallback?: string): string {
  const val = process.env[name] || fallback;
  if (!val) {
    throw new Error(`[Config] Required environment variable ${name} is not set`);
  }
  return val;
}

const isProd = process.env.NODE_ENV === 'production';

// Validate LiveKit secrets — never allow dev defaults in production
if (isProd) {
  if (!process.env.LIVEKIT_API_KEY) throw new Error('[Config] LIVEKIT_API_KEY is required in production');
  if (!process.env.LIVEKIT_API_SECRET) throw new Error('[Config] LIVEKIT_API_SECRET is required in production');
  if (!process.env.LIVEKIT_URL) throw new Error('[Config] LIVEKIT_URL is required in production');
} else if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  // Warn loudly when using dev secrets — these are insecure placeholders
  console.warn('[Config] WARNING: Using dev LiveKit secrets (LIVEKIT_API_KEY/LIVEKIT_API_SECRET not set). Set them for production!');
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: requireEnv('JWT_SECRET'),

  // SQLite database path
  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'veill.db'),

  // LiveKit (WebRTC calls via DGX + Cloudflare Tunnel)
  livekitUrl: process.env.LIVEKIT_URL || 'wss://preetllm.qzz.io',
  livekitApiKey: process.env.LIVEKIT_API_KEY || 'devkey',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || 'secret',

  // Firebase Admin (for FCM push + optional token verification)
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || '',

  // CORS — never default to wildcard in production
  corsOrigin: isProd
    ? requireEnv('CORS_ORIGIN')
    : (process.env.CORS_ORIGIN || 'http://localhost:5173'),

  // .veill file storage
  mediaDir: process.env.MEDIA_DIR || path.join(process.cwd(), 'media'),
  mediaMaxAgeMs: parseInt(process.env.MEDIA_MAX_AGE_MS || '86400000', 10), // 24h
} as const;
