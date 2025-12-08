import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { z } from 'zod';
import pg from 'pg';
import * as promClient from 'prom-client';

const { Pool } = pg as any;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3004);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
app.register(jwt as any, { secret: jwtSecret } as any);

// Prometheus metrics
const metricsRegistry = new promClient.Registry();
metricsRegistry.setDefaultLabels({ service: 'inventory' });
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

app.get('/health', async () => ({ status: 'ok', service: 'inventory' }));
app.get('/inventory/:productId', async (req) => {
  const productId = (req.params as any).productId as string;
  const { rows } = await pool.query('select qty from stock where product_id=$1', [Number(productId)]);
  return { productId, qty: rows[0]?.qty || 0 };
});

// Seed initial stock for demo products
async function ensureStockRow(productId: number) {
  await pool.query('insert into stock(product_id, qty) values ($1, 0) on conflict (product_id) do nothing', [productId]);
}

const setSchema = z.object({ productId: z.union([z.string(), z.number()]).transform(v=>Number(v)), qty: z.coerce.number().int().nonnegative() });
app.post('/inventory/set', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const parsed = setSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const { productId, qty } = parsed.data;
  await ensureStockRow(productId);
  await pool.query('update stock set qty=$1 where product_id=$2', [qty, productId]);
  return { productId: String(productId), qty };
});

const reserveSchema = z.object({ reservationId: z.string().min(1), productId: z.union([z.string(), z.number()]).transform(v=>Number(v)), qty: z.coerce.number().int().positive() });
app.post('/inventory/reserve', async (req, reply) => {
  const parsed = reserveSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const { reservationId, productId, qty } = parsed.data;
  await ensureStockRow(productId);
  const { rows } = await pool.query('select qty from stock where product_id=$1 for update', [productId]);
  const available = Number(rows[0]?.qty || 0);
  if (available < qty) return reply.code(409).send({ error: 'Insufficient stock' });
  await pool.query('update stock set qty=qty-$1 where product_id=$2', [qty, productId]);
  await pool.query('insert into reservations(reservation_id, product_id, qty) values ($1,$2,$3)', [reservationId, productId, qty]);
  return { reserved: true };
});

const commitSchema = z.object({ reservationId: z.string().min(1) });
app.post('/inventory/commit', async (req, reply) => {
  const parsed = commitSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const { reservationId } = parsed.data;
  const { rowCount } = await pool.query('delete from reservations where reservation_id=$1', [reservationId]);
  if (!rowCount) return reply.code(404).send({ error: 'Reservation not found' });
  return { committed: true };
});

const releaseSchema = z.object({ reservationId: z.string().min(1) });
app.post('/inventory/release', async (req, reply) => {
  const parsed = releaseSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const { reservationId } = parsed.data;
  const { rows } = await pool.query('delete from reservations where reservation_id=$1 returning product_id, qty', [reservationId]);
  if (!rows.length) return reply.code(404).send({ error: 'Reservation not found' });
  const r = rows[0] as { product_id: number; qty: number };
  await pool.query('update stock set qty=qty+$1 where product_id=$2', [r.qty, r.product_id]);
  return { released: true };
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

