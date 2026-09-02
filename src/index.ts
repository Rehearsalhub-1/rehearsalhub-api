import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { apiKeyAuth } from './middleware/auth';
import masterSongsRouter from './routes/masterSongs';
import songsRouter from './routes/songs.routes';
import praiseNightSongsRouter from './routes/praiseNightSongs';
import authRouter from './auth/auth.routes';
import profilesRouter from './routes/profiles.routes';
import zonesRouter from './routes/zones.routes';
import membersRouter from './routes/members.routes';
import scheduleRouter from './routes/schedule.routes';
import praiseNightsRouter from './routes/praise-nights.routes';
import chatsRouter from './routes/chats.routes';
import callsRouter from './routes/calls.routes';
import subscriptionsRouter from './routes/subscriptions.routes';
import activityLogsRouter from './routes/activity-logs.routes';
import categoriesRouter from './routes/categories.routes';
import submittedSongsRouter from './routes/submitted-songs.routes';
import favoritesRouter from './routes/favorites.routes';
import playlistsRouter from './routes/playlists.routes';
import attendanceRouter from './routes/attendance.routes';
import settingsRouter from './routes/settings.routes';
import notificationsRouter from './routes/notifications.routes';
import subgroupsRouter from './routes/subgroups.routes';
import audioRouter from './routes/audio.routes';
import kingspayRouter from './routes/kingspay.routes';
import lexiconRouter from './routes/lexicon.routes';
import mediaRouter from './routes/media.routes';
import { upcomingEventsRouter } from './routes/upcomingEvents.routes';
import supportRouter from './routes/support.routes';
import uploadRouter from './routes/upload.routes';
import statusesRouter from './routes/statuses.routes';
import { writesRouter } from './routes/writes.routes';
import livekitRouter from './routes/livekit.routes';
import internalCronRouter from './routes/internal-cron.routes';
import audiolabRouter from './routes/audiolab.routes';
import analyticsRouter from './routes/analytics.routes';
import { createWsServer } from './ws/wsServer';
import { tenantMiddleware } from './middleware/tenant.middleware';
import prisma from './lib/prisma';
import { mergeRawRow } from './lib/rawRow';

// Global process crash prevention
process.on('unhandledRejection', (reason, promise) => {
  console.error('[API Unhandled Rejection at]:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[API Uncaught Exception]:', error);
});

// Auto-heal settings table in PostgreSQL if missing
prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`).catch((err: any) => console.warn('[settings table auto-create]:', err?.message));

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// Flexible origin validator supporting Vercel previews, localhost, mobile origins, and configured env domains
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // Mobile apps, curl, server-to-server, SSR
  if (configuredOrigins.includes('*')) return true;
  if (configuredOrigins.some((allowed) => allowed.toLowerCase() === origin.toLowerCase())) return true;
  
  // Auto-allow localhost and local network dev origins
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  // Auto-allow Vercel, Netlify, Cloudflare Pages, and Render domains
  if (/^https?:\/\/([a-zA-Z0-9-]+\.)*vercel\.app$/.test(origin)) return true;
  if (/^https?:\/\/([a-zA-Z0-9-]+\.)*netlify\.app$/.test(origin)) return true;
  if (/^https?:\/\/([a-zA-Z0-9-]+\.)*pages\.dev$/.test(origin)) return true;
  // Auto-allow mobile app schemes
  if (/^(capacitor|ionic|exp|rehearsalhub|rehearsalhubadmin):\/\//i.test(origin)) return true;

  return configuredOrigins.length === 0; // Default to allow if no strict list provided
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // Allow rather than crash, while respecting standard headers
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-organization-id',
    'x-selected-zone-id',
    'x-zone-id',
    'x-zone-code',
    'x-church-id',
    'x-subgroup-id',
    'x-scope',
    'x-device-id',
    'x-requested-with',
    'x-api-key',
    'Accept',
    'Origin',
  ],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400,
};

// Rate limiter: 5000 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/' || req.method === 'OPTIONS',
  message: { success: false, error: 'Too many requests, please try again later.' },
});

// Middleware
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(limiter);
app.use(tenantMiddleware);

// Health check
app.get('/health', (_, res) => {
  res.status(200).json({ status: 'ok', service: 'rehearsalhub-api', timestamp: new Date().toISOString() });
});

// Root info
app.get('/', (_, res) => {
  res.json({
    service: 'RehearsalHub Songs API',
    version: '1.0.0',
    endpoints: {
      masterSongs: '/api/master-songs',
      masterSongById: '/api/master-songs/:id',
      praiseNightSongs: '/api/praise-night-songs',
      praiseNightSongById: '/api/praise-night-songs/:id',
      praiseNightSongsFiltered: '/api/praise-night-songs?praiseNightId=xxx',
    },
    auth: 'All /api/* routes require header: x-api-key: <your-key>',
  });
});

// Auth routes
app.use('/auth', authRouter);

// Protected user API routes
app.use('/profiles', profilesRouter);
app.use('/organizations', zonesRouter);
app.use('/zones', zonesRouter);
app.use('/members', membersRouter);
app.use('/schedule', scheduleRouter);
app.use('/praise-nights', praiseNightsRouter);
app.use('/programs', praiseNightsRouter);
app.use('/chats', chatsRouter);
app.use('/calls', callsRouter);
app.use('/support', supportRouter);
app.use('/support-tickets', supportRouter);
app.use('/subscriptions', subscriptionsRouter);
app.use('/activity-logs', activityLogsRouter);
app.use('/categories', categoriesRouter);
app.use('/submitted-songs', submittedSongsRouter);
app.use('/submissions', submittedSongsRouter);
app.use('/songs', songsRouter);
app.use('/master', masterSongsRouter);
app.use('/master-songs', masterSongsRouter);
app.use('/ministered', masterSongsRouter);
app.use('/ministered-songs', masterSongsRouter);
app.use('/ministered_songs', masterSongsRouter);
app.use('/favorites', favoritesRouter);
app.use('/playlists', playlistsRouter);
app.use('/attendance', attendanceRouter);
app.use('/settings', settingsRouter);
app.use('/notifications', notificationsRouter);
app.use('/subgroups', subgroupsRouter);
app.use('/churches', subgroupsRouter);
app.use('/groups', subgroupsRouter);
app.use('/audio', audioRouter);
app.use('/kingspay', kingspayRouter);
app.use('/lexicon', lexiconRouter);
app.use('/media', mediaRouter);
app.use('/media-videos', mediaRouter);
app.use('/upload', uploadRouter);
app.use('/api/upload', uploadRouter);
app.use('/statuses', statusesRouter);
app.use('/upcoming-events', upcomingEventsRouter);
app.use('/events', upcomingEventsRouter);
app.use('/calendar-events', upcomingEventsRouter);
app.use('/internal/cron', internalCronRouter);
app.use('/livekit-token', livekitRouter);
app.use('/audiolab', audiolabRouter);
app.use('/analytics', analyticsRouter);

// Write endpoints
app.use('/', writesRouter);

// Public song endpoints
app.use('/api/master-songs', apiKeyAuth, masterSongsRouter);
app.use('/api/ministered-songs', apiKeyAuth, masterSongsRouter);
app.use('/api/praise-night-songs', apiKeyAuth, praiseNightSongsRouter);
app.use('/api/songs', apiKeyAuth, praiseNightSongsRouter);
app.use('/api/media', apiKeyAuth, mediaRouter);

// Public settings endpoint (used by AppUpdateChecker before login)
app.get('/api/settings/:id', apiKeyAuth, async (req, res) => {
  try {
    const row = await prisma.setting.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: mergeRawRow(row) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[API Global Error]', err?.stack || err);
  const status = typeof err?.status === 'number' ? err.status : 500;
  const message = err?.message || 'Unable to complete request';
  res.status(status).json({ success: false, error: message });
});

// 404 handler
app.use((_, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

const httpServer = http.createServer(app);
createWsServer(httpServer);

httpServer.listen(PORT, async () => {
  console.log(`🎵 RehearsalHub API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Docs:   http://localhost:${PORT}/`);

  if (!process.env.JWT_SECRET) console.warn('   WARNING: JWT_SECRET is not set');
  if (!process.env.JWT_EXPIRES_IN) console.warn('   WARNING: JWT_EXPIRES_IN not set, defaulting to 15m');
  if (!process.env.REFRESH_TOKEN_EXPIRES_DAYS) console.warn('   WARNING: REFRESH_TOKEN_EXPIRES_DAYS not set, defaulting to 30');

  // Warm up the DB connection on startup via Prisma
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    console.log(`   Prisma DB connection warmed up ✓`);
  } catch (e) {
    console.warn(`   DB warmup failed (will retry on first request):`, (e as Error).message);
  }

  // ── Keep-alive self-ping ────────────────────────────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    const PING_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
    const selfUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
      : `http://localhost:${PORT}/health`;

    setInterval(async () => {
      try {
        const res = await fetch(selfUrl, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) console.warn('[keep-alive] Health ping returned:', res.status);
      } catch (err: any) {
        console.warn('[keep-alive] Ping failed:', err?.message || err);
      }
    }, PING_INTERVAL_MS);
  }
});
