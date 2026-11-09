import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from './lib/auth.js';
import { HttpError } from './lib/util.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import shipmentRoutes from './routes/shipments.js';
import warehouseRoutes from './routes/warehouse.js';
import driverRoutes from './routes/driver.js';
import financeRoutes from './routes/finance.js';
import adminRoutes from './routes/admin.js';
import reportRoutes from './routes/reports.js';
import routingRoutes from './routes/routing.js';
import crmRoutes from './routes/crm.js';
import customerRoutes from './routes/customer.js';
import intlRoutes from './routes/international.js';

export function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', ...config.mapTileHosts],
        'connect-src': ["'self'"],
        'media-src': ["'self'", 'blob:'],
        'worker-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'object-src': ["'none'"],
        'upgrade-insecure-requests': config.production ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  // Camera (barcode scan) & geolocation (GPS) are needed by the mobile apps on this origin only.
  app.use((_req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()'); next(); });
  app.use(express.json({ limit: '3mb' }));
  app.use((req, _res, next) => { req.db = db; req.config = config; next(); });

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'abc-cargo', time: new Date().toISOString() }));
  app.use('/api/auth', authRoutes(config));
  app.use('/api/public', publicRoutes);
  app.use('/api/shipments', requireAuth, shipmentRoutes);
  app.use('/api/warehouse', requireAuth, warehouseRoutes);
  app.use('/api/driver', requireAuth, driverRoutes);
  app.use('/api/finance', requireAuth, financeRoutes);
  app.use('/api/admin', requireAuth, adminRoutes);
  app.use('/api/reports', requireAuth, reportRoutes);
  app.use('/api/routing', requireAuth, routingRoutes);
  app.use('/api/crm', requireAuth, crmRoutes);
  app.use('/api/intl', requireAuth, intlRoutes);
  app.use('/api/customer', requireAuth, customerRoutes(config));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API route not found')));

  // Built web apps (ERP + 3 PWAs). Each app is its own HTML entry.
  const dist = config.webDist;
  if (dist && fs.existsSync(dist)) {
    app.use(express.static(dist, {
      index: false,
      setHeaders: (res, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    const page = (name) => (_req, res) => res.sendFile(path.join(dist, name));
    app.get('/', page('index.html'));
    for (const a of ['erp', 'driver', 'warehouse', 'customer']) app.get([`/${a}`, `/${a}/`], page(`${a}.html`));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    const status = err.status || 500;
    if (status >= 500) console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, details: err.details });
  });
  return app;
}
