require('dotenv').config();
const path = require('path');
const Fastify = require('fastify');
const cors = require('@fastify/cors');

const { initDB } = require('./db');
const { startLogWatcher, logEmitter } = require('./collectors/logs');
const { insertLog } = require('./db');
const { startBroadcastLoop, broadcast } = require('./stream/sse');

const metricsRoutes = require('./routes/metrics');
const logsRoutes = require('./routes/logs');
const containersRoutes = require('./routes/containers');
const aiRoutes = require('./routes/ai');
const streamRoutes = require('./routes/stream');
const authRoutes = require('./routes/auth');
const agentsRoutes = require('./routes/agents');
const billingRoutes = require('./routes/billing');
const ingestRoutes = require('./routes/ingest');

const PORT = parseInt(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' }
});

async function bootstrap() {
  // CORS
  const corsOrigin = process.env.CORS_ORIGIN === 'true' ? true : (process.env.CORS_ORIGIN || true);
  await fastify.register(cors, {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
  });

  // JWT
  await fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET || 'syswatch-dev-secret-change-in-production'
  });

  // Raw body (for Stripe webhook signature verification)
  await fastify.register(require('fastify-raw-body'), {
    field: 'rawBody',
    global: false,
    runFirst: true
  });

  // Serve static files (install.sh, etc.)
  await fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, '../public'),
    prefix: '/'
  });

  // Routes
  await fastify.register(authRoutes);
  await fastify.register(agentsRoutes);
  await fastify.register(billingRoutes);
  await fastify.register(ingestRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(logsRoutes);
  await fastify.register(containersRoutes);
  await fastify.register(aiRoutes);
  await fastify.register(streamRoutes);

  // Health check
  fastify.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  // Initialize DB
  await initDB();

  // Wire up log emitter → DB + SSE
  logEmitter.on('log', (log) => {
    try {
      const saved = insertLog(log);
      broadcast({ type: 'log', data: saved });
    } catch (err) {
      fastify.log.error('[LogEmitter] Failed to persist log:', err.message);
    }
  });

  startLogWatcher();
  startBroadcastLoop(5000);

  await fastify.listen({ port: PORT, host: HOST });
  console.log(`[SysWatch] Backend running on ${HOST}:${PORT}`);
}

bootstrap().catch((err) => {
  console.error('[SysWatch] Fatal startup error:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });
