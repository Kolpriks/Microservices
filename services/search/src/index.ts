import Fastify from 'fastify';
import { z } from 'zod';
import pg from 'pg';
import * as promClient from 'prom-client';

const { Pool } = pg as any;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3010);

// Prometheus metrics
const metricsRegistry = new promClient.Registry();
metricsRegistry.setDefaultLabels({ service: 'search' });
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

app.get('/health', async () => ({ status: 'ok', service: 'search' }));

// Поиск продуктов
const searchProductsSchema = z.object({
  q: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

app.get('/search/products', async (req, reply) => {
  const parsed = searchProductsSchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid query parameters', details: parsed.error.flatten() });
  }

  const { q, limit, offset } = parsed.data;
  let query = 'select id, name, price, seller_id as "sellerId" from products';
  const params: any[] = [];
  let paramIndex = 1;

  if (q && q.trim()) {
    query += ` where name ilike $${paramIndex}`;
    params.push(`%${q.trim()}%`);
    paramIndex++;
  }

  query += ` order by id limit $${paramIndex} offset $${paramIndex + 1}`;
  params.push(limit, offset);

  const { rows } = await pool.query(query, params);
  return { results: rows, count: rows.length, limit, offset };
});

// Поиск заказов
const searchOrdersSchema = z.object({
  userId: z.coerce.number().int().positive().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

app.get('/search/orders', async (req, reply) => {
  const parsed = searchOrdersSchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid query parameters', details: parsed.error.flatten() });
  }

  const { userId, status, limit, offset } = parsed.data;
  let query = 'select id, user_id as "userId", product_id as "productId", qty, status, tracking_id as "trackingId", created_at as "createdAt" from orders where 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (userId) {
    query += ` and user_id=$${paramIndex}`;
    params.push(userId);
    paramIndex++;
  }

  if (status) {
    query += ` and status=$${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  query += ` order by id desc limit $${paramIndex} offset $${paramIndex + 1}`;
  params.push(limit, offset);

  const { rows } = await pool.query(query, params);
  return { results: rows, count: rows.length, limit, offset };
});

// Универсальный поиск
const universalSearchSchema = z.object({
  q: z.string().min(1),
  type: z.enum(['products', 'orders', 'all']).optional().default('all'),
  limit: z.coerce.number().int().positive().max(50).optional().default(10),
});

app.post('/search', async (req, reply) => {
  const parsed = universalSearchSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  }

  const { q, type, limit } = parsed.data;
  const results: any = { query: q, type };

  if (type === 'products' || type === 'all') {
    const { rows } = await pool.query(
      'select id, name, price, seller_id as "sellerId" from products where name ilike $1 limit $2',
      [`%${q}%`, limit]
    );
    results.products = rows;
  }

  if (type === 'orders' || type === 'all') {
    const { rows } = await pool.query(
      'select id, user_id as "userId", product_id as "productId", qty, status, tracking_id as "trackingId" from orders where id::text ilike $1 or tracking_id ilike $1 limit $2',
      [`%${q}%`, limit]
    );
    results.orders = rows;
  }

  return results;
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

