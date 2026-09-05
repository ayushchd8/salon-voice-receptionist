import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { closePool } from './db/pool.js';
import { startIdempotencySweeper } from './plugins/idempotency.js';

const app = await buildApp();
const sweeper = startIdempotencySweeper();

try {
  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  logger.info(
    { port: config.API_PORT, docs: `http://${config.API_HOST}:${config.API_PORT}/docs` },
    'CRM API listening',
  );
} catch (err) {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
}

// Drain in-flight requests before closing the pool, so a deploy cannot cut a
// booking transaction in half.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweeper);
    await app.close();
    await closePool();
    process.exit(0);
  });
}
