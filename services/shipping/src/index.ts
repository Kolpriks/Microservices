import Fastify from 'fastify';
import { z } from 'zod';
import pg from 'pg';
import * as promClient from 'prom-client';

const app = Fastify({ logger: true });
const { Pool } = pg as any;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT || 3007);

// Prometheus metrics
const metricsRegistry = new promClient.Registry();
metricsRegistry.setDefaultLabels({ service: 'shipping' });
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

app.get('/health', async () => ({ status: 'ok', service: 'shipping' }));

const quotes = new Map<string, { price: number }>();
// Shipping stages the frontend should iterate through automatically
type ShipmentStatus = 'processing' | 'collected' | 'in_transit' | 'delivered_to_pickup';
type Shipment = { trackingId: string; status: ShipmentStatus; orderId: string; stages?: { name: ShipmentStatus; at: number }[] };

const baseUrl = {
  orders: process.env.ORDERS_URL || 'http://orders:3505',
  notifications: process.env.NOTIFY_URL || 'http://notifications:3508'
};

const quoteSchema = z.object({ orderId: z.string().min(1), address: z.string().min(3) });
app.post('/shipping/quote', async (req, reply) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const { orderId } = parsed.data;
  const price = 5 + (Number(orderId.replace(/\D/g, '').slice(-1) || '0'));
  quotes.set(orderId, { price });
  return { price };
});

const fulfillSchema = z.object({ orderId: z.string().min(1) });
app.post('/shipping/fulfill', async (req, reply) => {
  const parsed = fulfillSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const { orderId } = parsed.data;
  const trackingId = `TRK-${orderId}-${Date.now()}`;
  const shipment: Shipment = { trackingId, status: 'processing', orderId, stages: [{ name: 'processing', at: Date.now() }] };
  try {
    await pool.query('insert into shipments(order_id, tracking_id, status) values ($1,$2,$3)', [Number(orderId), trackingId, 'processing']);
    await pool.query('insert into shipment_stages(tracking_id, name) values ($1,$2)', [trackingId, 'processing']);
  } catch {}

  return { trackingId };
});

app.get('/shipping/track/:trackingId', async (req, reply) => {
  const trackingId = (req.params as any).trackingId as string;
  const ship = await pool.query('select order_id as "orderId", tracking_id as "trackingId", status from shipments where tracking_id=$1', [trackingId]);
  if (!ship.rows.length) return reply.code(404).send({ error: 'Not found' });
  const stages = await pool.query('select name, extract(epoch from at)*1000::bigint as at from shipment_stages where tracking_id=$1 order by id', [trackingId]);
  return { ...ship.rows[0], stages: stages.rows } as any;
});

// Frontend-driven advancement: processing -> collected -> in_transit -> delivered_to_pickup
const advanceSchema = z.object({ trackingId: z.string().min(1) });
app.post('/shipping/advance', async (req, reply) => {
  const parsed = advanceSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const { trackingId } = parsed.data;
  const cur = await pool.query('select order_id as "orderId", status from shipments where tracking_id=$1', [trackingId]);
  if (!cur.rows.length) return reply.code(404).send({ error: 'Not found' });
  const row = cur.rows[0] as { orderId: number; status: ShipmentStatus };
  let next: ShipmentStatus | null = null;
  if (row.status === 'processing') next = 'collected';
  else if (row.status === 'collected') next = 'in_transit';
  else if (row.status === 'in_transit') next = 'delivered_to_pickup';
  else next = null;
  if (!next) return { status: row.status, done: true } as any;
  try {
    await pool.query('update shipments set status=$1 where tracking_id=$2', [next, trackingId]);
    await pool.query('insert into shipment_stages(tracking_id, name) values ($1,$2)', [trackingId, next]);
  } catch {}
  // Notify and update order status accordingly
  try { await fetch(`${baseUrl.notifications}/notify`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type:`shipment_${next}`, to:'user', payload:{ orderId: row.orderId, trackingId } }) }); } catch {}
  try { await fetch(`${baseUrl.orders}/orders/${row.orderId}/status`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ status: next }) }); } catch {}
  return { status: next, done: next==='delivered_to_pickup' } as any;
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
