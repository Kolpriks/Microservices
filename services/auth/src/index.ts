import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import argon2 from 'argon2';
import pg from 'pg';
import { z } from 'zod';
import * as promClient from 'prom-client';

type Role = 'user' | 'seller' | 'admin';
type UserRecord = { id: string; email: string; password_hash: string; role: Role };
const { Pool } = pg as any;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3001);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';

app.register(jwt as any, { secret: jwtSecret } as any);

// Prometheus metrics
const metricsRegistry = new promClient.Registry();
metricsRegistry.setDefaultLabels({ service: 'auth' });
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

app.get('/health', async () => ({ status: 'ok', service: 'auth' }));

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['user','seller','admin']).optional().default('user')
});

app.post('/auth/register', async (req, reply) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  const { email, password, role } = parsed.data;
  const exists = await pool.query('select id from users where email=$1', [email]);
  if (exists.rowCount) return reply.code(409).send({ error: 'User already exists' });
  const passwordHash = await argon2.hash(password);
  const { rows } = await pool.query('insert into users(email, password_hash, role) values ($1,$2,$3) returning id, email, role', [email, passwordHash, role]);
  
  // HTTP-взаимодействие: вызываем сервис Profile для создания профиля пользователя
  const profileUrl = process.env.PROFILE_URL || 'http://127.0.0.1:3002';
  try {
    await fetch(`${profileUrl}/profiles/me`, {
      method: 'PUT',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${(app as any).jwt.sign({ sub: String(rows[0].id), email: rows[0].email, role: rows[0].role })}`
      },
      body: JSON.stringify({ name: email.split('@')[0] })
    });
  } catch (err) {
    // Логируем ошибку, но не прерываем регистрацию
    app.log.warn({ err }, 'Failed to create profile during registration');
  }
  
  return reply.code(201).send(rows[0]);
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

app.post('/auth/login', async (req, reply) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;
  const { rows } = await pool.query('select id, email, password_hash, role from users where email=$1', [email]);
  if (!rows.length) return reply.code(401).send({ error: 'Invalid credentials' });
  const user = rows[0] as UserRecord;
  const ok = await argon2.verify(user.password_hash, password);
  if (!ok) return reply.code(401).send({ error: 'Invalid credentials' });
  const token = (app as any).jwt.sign({ sub: String(user.id), email: user.email, role: user.role });
  return { token };
});

app.get('/auth/me', async (req, reply) => {
  try {
    await (req as any).jwtVerify();
  } catch (err) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const payload = (req as any).user as { sub: string; email: string; role?: Role };
  return { id: payload.sub, email: payload.email, role: payload.role ?? 'user' };
});

// Refresh token endpoint
app.post('/auth/refresh', async (req, reply) => {
  try {
    await (req as any).jwtVerify();
  } catch (err) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const payload = (req as any).user as { sub: string; email: string; role?: Role };
  const token = (app as any).jwt.sign({ sub: payload.sub, email: payload.email, role: payload.role ?? 'user' });
  return { token };
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

