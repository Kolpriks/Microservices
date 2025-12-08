import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { z } from 'zod';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pg = require('pg');
import * as promClient from 'prom-client';

type ShippingStage = 'processing' | 'collected' | 'in_transit' | 'delivered_to_pickup' | 'received';
type OrderStatus = 'created_unpaid' | 'created_paid' | 'failed' | ShippingStage;
type Order = { id: string; userId: string; productId: string; qty: number; status: OrderStatus; trackingId?: string };
type Product = { id: string; name: string; price: number; sellerId: string };

const { Pool } = pg as any;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3005);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
app.register(jwt as any, { secret: jwtSecret } as any);

// Prometheus metrics
const metricsRegistry = new promClient.Registry();
metricsRegistry.setDefaultLabels({ service: 'orders' });
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

app.get('/health', async () => ({ status: 'ok', service: 'product-order' }));

const baseUrl = {
  inventory: process.env.INVENTORY_URL || 'http://127.0.0.1:3004',
  payments: process.env.PAYMENTS_URL || 'http://127.0.0.1:3006',
  shipping: process.env.SHIPPING_URL || 'http://127.0.0.1:3007',
  notifications: process.env.NOTIFY_URL || 'http://127.0.0.1:3008'
};

const createSchema = z.object({
  productId: z.union([z.string(), z.number()]).transform(v => String(v)).refine(v => v.length > 0, 'productId required'),
  qty: z.coerce.number().int().positive()
});

async function setOrderStatus(orderId: string, status: OrderStatus, trackingId?: string) {
  const fields: string[] = ['status=$1'];
  const values: any[] = [status];
  if (trackingId !== undefined) { fields.push('tracking_id=$2'); values.push(trackingId); }
  const setClause = fields.join(', ');
  await pool.query(`update orders set ${setClause} where id=$${values.length+1}`, [...values, Number(orderId)]);
}

// Вложенная функция для обработки платежа - вызывает сервис Payments
async function processPayment(orderId: string, amount: number, currency: string, userEmail: string): Promise<{ ok: boolean; paymentId?: string; error?: string }> {
  // Эта вложенная функция внутри processOrder выполняет HTTP-запрос к микросервису Payments
  let paid = false;
  let paymentId: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    paymentId = `p-${orderId}-${attempt}`;
    const r = await fetch(`${baseUrl.payments}/payments/charge`, { 
      method: 'POST', 
      headers: { 'content-type': 'application/json' }, 
      body: JSON.stringify({ paymentId, amount, currency, orderId }) 
    });
    if (r.ok) { 
      paid = true; 
      break; 
    }
  }
  if (!paid) {
    // Вложенная функция также вызывает сервис Notifications
    await fetch(`${baseUrl.notifications}/notify`, { 
      method: 'POST', 
      headers: { 'content-type': 'application/json' }, 
      body: JSON.stringify({ type: 'payment_failed', to: userEmail, payload: { id: orderId } }) 
    });
    return { ok: false, error: 'Payment failed' };
  }
  return { ok: true, paymentId };
}

async function processOrder(order: Order, userEmail: string) {
  const reservationId = `r-${order.id}-${Date.now()}`;
  // Reserve stock
  {
    const r = await fetch(`${baseUrl.inventory}/inventory/reserve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reservationId, productId: order.productId, qty: order.qty }) });
    if (!r.ok) {
      await fetch(`${baseUrl.notifications}/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'order_failed', to: userEmail, payload: { id: order.id, reason: 'stock' } }) });
      await setOrderStatus(order.id, 'failed');
      return { ok: false, code: 409, error: 'Stock reservation failed' };
    }
  }

  // Получаем цену продукта из БД для расчета суммы платежа
  const productRes = await pool.query('select price from products where id=$1', [Number(order.productId)]);
  const productPrice = productRes.rows[0]?.price || 0;
  const totalAmount = Number(productPrice) * order.qty;

  // Используем вложенную функцию processPayment для обработки платежа
  const paymentResult = await processPayment(order.id, totalAmount, 'USD', userEmail);
  if (!paymentResult.ok) {
    await fetch(`${baseUrl.inventory}/inventory/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reservationId }) });
    await setOrderStatus(order.id, 'failed');
    return { ok: false, code: 402, error: paymentResult.error || 'Payment failed' };
  }

  // Commit stock
  await fetch(`${baseUrl.inventory}/inventory/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reservationId }) });

  // Create shipment and set order status to created_paid; shipping stages will advance via frontend polling
  const shipRes = await fetch(`${baseUrl.shipping}/shipping/fulfill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: order.id }) });
  const ship = await shipRes.json();
  await setOrderStatus(order.id, 'created_paid', ship.trackingId);

  await fetch(`${baseUrl.notifications}/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'order_confirmed', to: userEmail, payload: { id: order.id, trackingId: ship.trackingId } }) });
  return { ok: true };
}
app.post('/orders', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const user = (req as any).user as { sub: string; email: string };
  const userIdNum = Number(user.sub);
  if (!Number.isFinite(userIdNum)) return reply.code(401).send({ error: 'Invalid token user id' });
  const u = await pool.query('select 1 from users where id=$1', [userIdNum]);
  if (!u.rowCount) return reply.code(401).send({ error: 'User not found' });
  const ins = await pool.query('insert into orders(user_id, product_id, qty, status) values ($1,$2,$3,$4) returning id, user_id as "userId", product_id as "productId", qty, status, tracking_id as "trackingId"', [userIdNum, Number(parsed.data.productId), parsed.data.qty, 'created_unpaid']);
  const order = ins.rows[0] as Order;
  // Do NOT auto-pay. Return unpaid order; client can call /orders/:id/pay later
  return reply.code(201).send(order);
});

app.get('/orders/:id', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const id = (req.params as any).id as string;
  const { rows } = await pool.query('select id, user_id as "userId", product_id as "productId", qty, status, tracking_id as "trackingId" from orders where id=$1', [Number(id)]);
  const o = rows[0] as Order | undefined;
  if (!o) return reply.code(404).send({ error: 'Not found' });
  const user = (req as any).user as { sub: string };
  if (o.userId !== user.sub) return reply.code(403).send({ error: 'Forbidden' });
  return o;
});

app.get('/orders', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const user = (req as any).user as { sub: string };
  const userIdNum = Number(user.sub);
  if (!Number.isFinite(userIdNum)) return reply.code(401).send({ error: 'Invalid token user id' });
  const { rows } = await pool.query('select id, user_id as "userId", product_id as "productId", qty, status, tracking_id as "trackingId" from orders where user_id=$1 order by id desc', [userIdNum]);
  return rows as Order[];
});

app.post('/orders/:id/cancel', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const id = (req.params as any).id as string;
  const { rows } = await pool.query('select id, status from orders where id=$1', [Number(id)]);
  if (!rows.length) return reply.code(404).send({ error: 'Not found' });
  const o = rows[0] as { id: number; status: OrderStatus };
  if (o.status !== 'created_unpaid') return reply.code(409).send({ error: 'Cannot cancel' });
  await setOrderStatus(String(o.id), 'failed');
  await fetch(`${baseUrl.notifications}/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'order_cancelled', to: 'user', payload: { id } }) });
  return { cancelled: true };
});

// Retry payment and shipping for an order
app.post('/orders/:id/pay', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const id = (req.params as any).id as string;
  const { rows } = await pool.query('select id, user_id as "userId", product_id as "productId", qty, status, tracking_id as "trackingId" from orders where id=$1', [Number(id)]);
  const o = rows[0] as Order | undefined;
  if (!o) return reply.code(404).send({ error: 'Not found' });
  const user = (req as any).user as { email: string };
  // allow retry if failed or created
  if (o.status !== 'failed' && o.status !== 'created_unpaid') return reply.code(409).send({ error: 'Order not payable' });
  const res = await processOrder(o, user.email);
  if (!res.ok) return reply.code(res.code as number).send({ error: res.error });
  return { ok: true, order: o };
});

// Update order status (internal from shipping): processing | collected | in_transit | delivered_to_pickup
const statusSchema = z.object({ status: z.enum(['processing','collected','in_transit','delivered_to_pickup']) });
app.post('/orders/:id/status', async (req, reply) => {
  const id = (req.params as any).id as string;
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const { rows } = await pool.query('select id from orders where id=$1', [Number(id)]);
  if (!rows.length) return reply.code(404).send({ error: 'Not found' });
  await setOrderStatus(id, parsed.data.status);
  return { ok: true };
});

// User acknowledges receipt
app.post('/orders/:id/received', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const id = (req.params as any).id as string;
  const { rows } = await pool.query('select id, user_id as "userId", status from orders where id=$1', [Number(id)]);
  if (!rows.length) return reply.code(404).send({ error: 'Not found' });
  const o = rows[0] as { id: number; userId: number; status: OrderStatus };
  const user = (req as any).user as { sub: string };
  if (String(o.userId) !== user.sub) return reply.code(403).send({ error: 'Forbidden' });
  if (o.status !== 'delivered_to_pickup') return reply.code(409).send({ error: 'Not ready to receive' });
  await setOrderStatus(String(o.id), 'received');
  return { ok: true };
});

// ========== PRODUCT ENDPOINTS ==========
// Products endpoints (объединены с orders в один микросервис)

app.get('/products', async () => {
  const { rows } = await pool.query('select id, name, price, seller_id as "sellerId", image_id as "imageId" from products order by id limit 100');
  return rows;
});

const createProductSchema = z.object({ name: z.string().min(1), price: z.number().positive(), imageId: z.string().optional() });
app.post('/products', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const user = (req as any).user as { sub: string };
  const { rows } = await pool.query('insert into products(name, price, seller_id, image_id) values ($1,$2,$3,$4) returning id, name, price, seller_id as "sellerId", image_id as "imageId"', [parsed.data.name, parsed.data.price, Number(user.sub), parsed.data.imageId || null]);
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
