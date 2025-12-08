import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { z } from 'zod';
import pg from 'pg';
import * as promClient from 'prom-client';

type Product = { id: string; name: string; price: number; sellerId: string; imageId?: string };
const { Pool } = pg as any;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3003);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
app.register(jwt as any, { secret: jwtSecret } as any);

// Prometheus metrics
const metricsRegistry = new promClient.Registry();
metricsRegistry.setDefaultLabels({ service: 'catalog' });
promClient.collectDefaultMetrics({ register: metricsRegistry });
const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method','route','status_code'] as const,
  registers: [metricsRegistry],
});
const httpRequestDurationSeconds = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method','route','status_code'] as const,
  buckets: [0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2,5],
  registers: [metricsRegistry],
});
app.addHook('onRequest', (req: any, _reply: any, done: any) => {
  req._metricsStart = process.hrtime.bigint();
  done();
});
app.addHook('onResponse', (req: any, reply: any, done: any) => {
  try {
    const start = req._metricsStart as bigint | undefined;
    const route = (req.routeOptions && req.routeOptions.url) || req.url || '';
    const method = (req.method || 'GET').toUpperCase();
    const status = String(reply.statusCode || 0);
    httpRequestsTotal.inc({ method, route, status_code: status });
    if (start) {
      const ns = Number(process.hrtime.bigint() - start);
      httpRequestDurationSeconds.observe({ method, route, status_code: status }, ns / 1e9);
    }
  } catch {}
  done();
});
app.get('/metrics', async (_req, reply) => {
  reply.header('content-type', metricsRegistry.contentType);
  return metricsRegistry.metrics();
});

app.get('/health', async () => ({ status: 'ok', service: 'catalog' }));

// Seed demo products if empty
// list products from DB
app.get('/products', async () => {
  const { rows } = await pool.query('select id, name, price, seller_id as "sellerId", image_id as "imageId" from products order by id limit 100');
  return rows;
});

const createSchema = z.object({ name: z.string().min(1), price: z.number().positive() });
app.post('/products', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const user = (req as any).user as { sub: string };
  const { rows } = await pool.query('insert into products(name, price, seller_id) values ($1,$2,$3) returning id, name, price, seller_id as "sellerId", image_id as "imageId"', [parsed.data.name, parsed.data.price, Number(user.sub)]);
  return reply.code(201).send(rows[0]);
});

app.get('/products/:id', async (req, reply) => {
  const id = (req.params as any).id as string;
  const { rows } = await pool.query('select id, name, price, seller_id as "sellerId", image_id as "imageId" from products where id=$1', [Number(id)]);
  if (!rows.length) return reply.code(404).send({ error: 'Not found' });
  return rows[0];
});

async function start() {
  try {
    const address = await app.listen({ port, host: '0.0.0.0' });
    app.log.info({ address }, 'listening');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
