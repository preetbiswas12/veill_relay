import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',

  // PostgreSQL
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/veill',

  // LiveKit (WebRTC calls via DGX + Cloudflare Tunnel)
  livekitUrl: process.env.LIVEKIT_URL || 'wss://preetllm.qzz.io',
  livekitApiKey: process.env.LIVEKIT_API_KEY || 'devkey',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || 'secret',

  // Firebase Admin (for FCM push + optional token verification)
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || '',

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // Chunk relay
  chunkTempDir: process.env.CHUNK_TEMP_DIR || '/tmp/veill-chunks',
  chunkMaxAgeMs: parseInt(process.env.CHUNK_MAX_AGE_MS || '86400000', 10), // 24h
} as const;
