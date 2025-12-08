import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { z } from 'zod';
import pg from 'pg';
import * as promClient from 'prom-client';

type Address = { id: string; line1: string; city: string; zip: string };
type Profile = { id: string; email: string; name?: string; phone?: string; addresses?: Address[] };
const { Pool } = pg as any;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type CartItem = { productId: string; qty: number };

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3002);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
app.register(jwt as any, { secret: jwtSecret } as any);

// Prometheus metrics
const metricsRegistry = new promClient.Registry();
metricsRegistry.setDefaultLabels({ service: 'profile' });
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

async function resolveDbUserId(token: { sub: string; email: string }): Promise<number> {
  const byId = Number(token.sub);
  if (Number.isFinite(byId)) {
    const r = await pool.query('select id from users where id=$1', [byId]);
    if (r.rowCount) return byId;
  }
  const byEmail = await pool.query('select id from users where email=$1', [token.email]);
  if (byEmail.rowCount) return Number(byEmail.rows[0].id);
  throw Object.assign(new Error('User not found'), { statusCode: 401 });
}

app.get('/health', async () => ({ status: 'ok', service: 'profile' }));
// Cart endpoints (persisted in DB)
app.get('/profiles/me/cart', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const user = (req as any).user as { sub: string; email: string };
  let userId: number; try { userId = await resolveDbUserId(user); } catch { return reply.code(401).send({ error: 'User not found' }); }
  const { rows } = await pool.query('select product_id as "productId", qty from cart where user_id=$1 order by product_id', [userId]);
  return rows.map((r:any)=> ({ productId: String(r.productId), qty: Number(r.qty) })) as CartItem[];
});

const cartSetSchema = z.object({ productId: z.union([z.string(), z.number()]).transform(v=>Number(v)), qty: z.coerce.number().int().nonnegative() });
app.post('/profiles/me/cart', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const user = (req as any).user as { sub: string; email: string };
  let userId: number; try { userId = await resolveDbUserId(user); } catch { return reply.code(401).send({ error: 'User not found' }); }
  const parsed = cartSetSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const { productId, qty } = parsed.data;
  if (qty === 0) {
    await pool.query('delete from cart where user_id=$1 and product_id=$2', [userId, productId]);
    return { ok: true };
  } else {
    // Use UPSERT: if record exists, update qty to the new value; otherwise insert new
    // This is atomic and prevents race conditions
    await pool.query(
      `insert into cart(user_id, product_id, qty) 
       values ($1, $2, $3) 
       on conflict (user_id, product_id) 
       do update set qty = excluded.qty`,
      [userId, productId, qty]
    );
  }
  // Return updated cart item to confirm the operation
  const { rows } = await pool.query(
    'select product_id as "productId", qty from cart where user_id=$1 and product_id=$2',
    [userId, productId]
  );
  if (rows.length > 0) {
    return { ok: true, productId: String(rows[0].productId), qty: Number(rows[0].qty) };
  }
  return { ok: true };
});

// Clear entire cart for current user
app.delete('/profiles/me/cart', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const user = (req as any).user as { sub: string; email: string };
  let userId: number; try { userId = await resolveDbUserId(user); } catch { return reply.code(401).send({ error: 'User not found' }); }
  await pool.query('delete from cart where user_id=$1', [userId]);
  return { ok: true };
});


app.get('/profiles/me', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const user = (req as any).user as { sub: string; email: string };
  let userId: number; try { userId = await resolveDbUserId(user); } catch { return reply.code(401).send({ error: 'User not found' }); }
  const { rows } = await pool.query('select p.id, u.email, p.name, p.phone from users u left join profiles p on p.user_id=u.id where u.id=$1', [userId]);
  const base = rows[0] || { id: userId, email: user.email, name: null, phone: null };
  const addrs = await pool.query('select id, line1, city, zip from addresses where user_id=$1 order by id', [userId]);
  return { id: String(base.id), email: base.email, name: base.name || undefined, phone: base.phone || undefined, addresses: addrs.rows } as Profile;
});

const updateSchema = z.object({ name: z.string().min(1).optional(), phone: z.string().min(5).optional() });
app.put('/profiles/me', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const user = (req as any).user as { sub: string; email: string };
  const { name, phone } = parsed.data;
  let userId: number; try { userId = await resolveDbUserId(user); } catch { return reply.code(401).send({ error: 'User not found' }); }
  const { rows } = await pool.query('select id from profiles where user_id=$1', [userId]);
  if (rows.length) {
    await pool.query('update profiles set name=coalesce($1,name), phone=coalesce($2,phone) where user_id=$3', [name || null, phone || null, userId]);
  } else {
    await pool.query('insert into profiles(user_id, name, phone) values ($1,$2,$3)', [userId, name || null, phone || null]);
  }
  const me = await pool.query('select p.id, u.email, p.name, p.phone from users u left join profiles p on p.user_id=u.id where u.id=$1', [userId]);
  const base = me.rows[0] || { id: userId, email: user.email, name: null, phone: null };
  const addrs = await pool.query('select id, line1, city, zip from addresses where user_id=$1 order by id', [userId]);
  return { id: String(base.id), email: base.email, name: base.name || undefined, phone: base.phone || undefined, addresses: addrs.rows } as Profile;
});

// Addresses
app.get('/profiles/me/addresses', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const user = (req as any).user as { sub: string; email: string };
  let userId: number; try { userId = await resolveDbUserId(user); } catch { return reply.code(401).send({ error: 'User not found' }); }
  const { rows } = await pool.query('select id, line1, city, zip from addresses where user_id=$1 order by id', [userId]);
  return rows as Address[];
});

const addrSchema = z.object({ line1: z.string().min(3), city: z.string().min(2), zip: z.string().min(3) });
app.post('/profiles/me/addresses', async (req, reply) => {
  try { await (req as any).jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  const parsed = addrSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  const user = (req as any).user as { sub: string; email: string };
  let userId: number; try { userId = await resolveDbUserId(user); } catch { return reply.code(401).send({ error: 'User not found' }); }
  const { rows } = await pool.query('insert into addresses(user_id, line1, city, zip) values ($1,$2,$3,$4) returning id, line1, city, zip', [userId, parsed.data.line1, parsed.data.city, parsed.data.zip]);
  return reply.code(201).send({ ...rows[0], id: String(rows[0].id) } as Address);
});

async function start() {
  try {
    // ensure cart table exists for persistence
    try { await pool.query('create table if not exists cart (user_id int not null references users(id) on delete cascade, product_id int not null references products(id) on delete cascade, qty int not null, primary key(user_id, product_id))'); } catch {}
    const address = await app.listen({ port, host: '0.0.0.0' });
    app.log.info({ address }, 'listening');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

