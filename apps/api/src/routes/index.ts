import type { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/pool.js';
import { authRoutes } from './auth.js';
import { salonRoutes } from './salon.js';
import { catalogRoutes } from './catalog.js';
import { customerRoutes } from './customers.js';
import { availabilityRoutes } from './availability.js';
import { appointmentRoutes } from './appointments.js';
import { callRoutes } from './calls.js';

export const registerRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/health',
    { schema: { hide: true } },
    async () => ({ status: 'ok', uptime: Math.round(process.uptime()) }),
  );

  // Distinct from /health: readiness depends on the database, liveness does not.
  // A failing dependency should drain traffic, not trigger a restart loop.
  app.get('/ready', { schema: { hide: true } }, async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      reply.status(503);
      return { status: 'degraded', reason: 'database unreachable' };
    }
  });

  await app.register(authRoutes);
  await app.register(salonRoutes);
  await app.register(catalogRoutes);
  await app.register(customerRoutes);
  await app.register(availabilityRoutes);
  await app.register(appointmentRoutes);
  await app.register(callRoutes);
};
