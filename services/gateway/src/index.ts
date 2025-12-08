import Fastify from 'fastify';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore types may be missing, runtime import is fine
import fastifyStatic from '@fastify/static';
import * as path from 'path';
// Custom lightweight reverse proxy using fetch
import * as promClient from 'prom-client';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3500);

// Fastify already parses JSON by default, no need to add custom parser

// Prometheus metrics
const metricsRegistry = new promClient.Registry();
metricsRegistry.setDefaultLabels({ service: 'gateway' });
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

const targets = {
  auth: process.env.AUTH_URL || 'http://127.0.0.1:3001',
  profile: process.env.PROFILE_URL || 'http://127.0.0.1:3002',
  productOrder: process.env.PRODUCT_ORDER_URL || 'http://127.0.0.1:3005',
  inventory: process.env.INVENTORY_URL || 'http://127.0.0.1:3004',
  payments: process.env.PAYMENTS_URL || 'http://127.0.0.1:3006',
  shipping: process.env.SHIPPING_URL || 'http://127.0.0.1:3007',
  notifications: process.env.NOTIFY_URL || 'http://127.0.0.1:3008',
  images: process.env.IMAGES_URL || 'http://127.0.0.1:3009',
  search: process.env.SEARCH_URL || 'http://127.0.0.1:3010',
};

app.get('/health', async () => ({ status: 'ok', service: 'gateway' }));

app.get('/upstreams', async () => {
  const urls = [
    { name: 'auth', url: targets.auth + '/health' },
    { name: 'profile', url: targets.profile + '/health' },
    { name: 'product-order', url: targets.productOrder + '/health' },
    { name: 'inventory', url: targets.inventory + '/health' },
    { name: 'payments', url: targets.payments + '/health' },
    { name: 'shipping', url: targets.shipping + '/health' },
    { name: 'notifications', url: targets.notifications + '/health' },
    { name: 'images', url: targets.images + '/health' },
    { name: 'search', url: targets.search + '/health' },
  ];
  const results: any = {};
  for (const u of urls) {
    try {
      const r = await fetch(u.url);
      results[u.name] = { ok: r.ok, status: r.status };
    } catch (e: any) {
      results[u.name] = { ok: false, error: String(e && e.message || e) };
    }
  }
  return results;
});

// Removed inline homepage route. SPA is served from services/web/dist via static plugin below.
// Serve SPA build if exists
try {
  // __dirname is available in CJS output; tsconfig compiles to commonjs here
  // eslint-disable-next-line no-undef
  const webDist = path.resolve(__dirname as any, '../../web/dist');
  (app as any).register(fastifyStatic as any, { root: webDist, prefix: '/' } as any);
  // SPA fallback: serve index.html for unknown GET routes not starting with API prefix
  const apiPrefixes = ['/api','/upstreams','/health'];
  app.setNotFoundHandler((req: any, reply: any) => {
    const url = req.url || '';
    if (req.method !== 'GET' || apiPrefixes.some((p) => url.startsWith(p))) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.type('text/html').sendFile('index.html');
  });
} catch {}

type UpstreamKey = keyof typeof targets;
function registerProxy(prefix: string, upstreamKey: UpstreamKey) {
  const base = targets[upstreamKey].replace(/\/$/, '');
  const handler = async (req: any, reply: any) => {
    const originalPath = (req.raw && typeof req.raw.url === 'string') ? req.raw.url : (req.url || '');
    // Strip leading /api to match upstream service routes (e.g., /api/products -> /products)
    const strippedPath = originalPath.replace(/^\/(api)(?=\/|$)/, '');
    const pathForUpstream = strippedPath.startsWith('/') ? strippedPath : ('/' + strippedPath);
    const targetUrl = new URL(pathForUpstream, base).toString();
    const method = req.method;
    const incomingHeaders = req.headers as Record<string, string | string[]>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(incomingHeaders)) {
      if (k.toLowerCase() === 'host') continue;
      if (Array.isArray(v)) headers[k] = v.join(','); else if (v !== undefined) headers[k] = String(v);
    }
    let body: any = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        const ct = (headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          // Fastify already parsed JSON body, just stringify it back
          if (req.body !== undefined) {
            body = JSON.stringify(req.body);
            headers['content-type'] = 'application/json';
            headers['content-length'] = Buffer.byteLength(body).toString();
          }
        } else {
          // For non-JSON, read raw body
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            req.raw.on('data', (c: Buffer) => chunks.push(c));
            req.raw.on('end', () => resolve());
            req.raw.on('error', reject);
          });
          body = chunks.length ? Buffer.concat(chunks) : undefined;
          if (body) headers['content-length'] = Buffer.byteLength(body).toString();
        }
      } catch (err: any) {
        req.log.warn({ err }, 'Error reading body');
      }
    }
    try {
      req.log.debug({ targetUrl, method, upstreamKey, originalPath, pathForUpstream }, 'proxying request');
      const res = await fetch(targetUrl, { method, headers, body: body as any });
      reply.status(res.status);
      res.headers.forEach((val, key) => {
        if (key.toLowerCase() === 'content-encoding') return;
        reply.header(key, val);
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return reply.send(buf);
    } catch (err: any) {
      req.log.error({ err, url: targetUrl, upstreamKey, base, originalPath, pathForUpstream }, 'proxy error');
      return reply.code(503).send({ error: 'Service Unavailable', url: targetUrl, message: err?.message || String(err) });
    }
  };
  // exact prefix and nested routes
  app.all(prefix, handler);
  app.all(`${prefix}/*`, handler);
}

// Mount API under /api/* to avoid clashing with SPA routes
registerProxy('/api/auth', 'auth');
registerProxy('/api/profiles', 'profile');
registerProxy('/api/products', 'productOrder');
registerProxy('/api/orders', 'productOrder');
registerProxy('/api/inventory', 'inventory');
registerProxy('/api/payments', 'payments');
registerProxy('/api/shipping', 'shipping');
registerProxy('/api/notify', 'notifications');
registerProxy('/api/images', 'images');
registerProxy('/api/search', 'search');

async function start() {
  try {
    const address = await app.listen({ port, host: '0.0.0.0' });
    app.log.info({ address }, 'gateway listening');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

