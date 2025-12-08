import Fastify from 'fastify';
import { z } from 'zod';
import pg from 'pg';
import * as promClient from 'prom-client';

const { Pool } = pg as any;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3006);

// Prometheus metrics
const metricsRegistry = new promClient.Registry();
metricsRegistry.setDefaultLabels({ service: 'payments' });
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

app.get('/health', async () => ({ status: 'ok', service: 'payments' }));

const chargeSchema = z.object({
  paymentId: z.coerce.string().min(1),
  amount: z.coerce.number().positive(),
  currency: z.coerce.string().min(1),
  orderId: z.union([z.string(), z.number()]).transform(v=>String(v)).optional(),
});
app.post('/payments/charge', async (req, reply) => {
  const parsed = chargeSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const { paymentId, amount, currency } = parsed.data as any;
  // Simulate success for even ids and failure for odd (simple determinism)
  const ok = Number(paymentId.replace(/\D/g, '').slice(-1) || '0') % 2 === 0;
  const status = ok ? 'captured' : 'failed';
  try {
    await pool.query('insert into payments(payment_id, amount, currency, status, order_id) values ($1,$2,$3,$4,$5)', [paymentId, amount, currency, status, parsed.data.orderId ? Number(parsed.data.orderId) : null]);
  } catch {}
  if (!ok) return reply.code(402).send({ status: 'failed' });
  return { status: 'captured', paymentId };
});

// Получение информации о платеже
app.get('/payments/:id', async (req, reply) => {
  const id = (req.params as any).id as string;
  try {
    const { rows } = await pool.query(
      'select id, payment_id as "paymentId", amount, currency, status, order_id as "orderId", created_at as "createdAt" from payments where payment_id=$1',
      [id]
    );
    if (!rows.length) {
      return reply.code(404).send({ error: 'Payment not found' });
    }
    return rows[0];
  } catch (err: any) {
    app.log.error({ err }, 'Error fetching payment');
    return reply.code(500).send({ error: 'Failed to fetch payment' });
  }
});

// Получение платежей по заказу
app.get('/payments/order/:orderId', async (req, reply) => {
  const orderId = (req.params as any).orderId as string;
  try {
    const { rows } = await pool.query(
      'select id, payment_id as "paymentId", amount, currency, status, order_id as "orderId", created_at as "createdAt" from payments where order_id=$1 order by id desc',
      [Number(orderId)]
    );
    return rows;
  } catch (err: any) {
    app.log.error({ err }, 'Error fetching payments for order');
    return reply.code(500).send({ error: 'Failed to fetch payments' });
  }
});

// Возврат платежа
const refundSchema = z.object({
  paymentId: z.string().min(1),
  amount: z.coerce.number().positive().optional(),
  reason: z.string().optional(),
});

app.post('/payments/refund', async (req, reply) => {
  const parsed = refundSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  }

  const { paymentId, amount, reason } = parsed.data;
  try {
    // Получаем информацию о платеже
    const { rows } = await pool.query(
      'select id, payment_id, amount, currency, status from payments where payment_id=$1',
      [paymentId]
    );
    if (!rows.length) {
      return reply.code(404).send({ error: 'Payment not found' });
    }

    const payment = rows[0];
    if (payment.status !== 'captured') {
      return reply.code(409).send({ error: 'Payment cannot be refunded', status: payment.status });
    }

    const refundAmount = amount || payment.amount;
    // Обновляем статус платежа (в реальной системе создали бы отдельную запись о возврате)
    await pool.query(
      'update payments set status=$1 where payment_id=$2',
      ['refunded', paymentId]
    );

    return { refunded: true, paymentId, amount: refundAmount, reason: reason || 'User request' };
  } catch (err: any) {
    app.log.error({ err }, 'Error processing refund');
    return reply.code(500).send({ error: 'Failed to process refund' });
  }
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

