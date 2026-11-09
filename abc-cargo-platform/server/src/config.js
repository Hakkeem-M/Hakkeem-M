import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  let jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    if (production) throw new Error('JWT_SECRET (>= 32 chars) is required in production');
    jwtSecret = crypto.randomBytes(32).toString('hex'); // dev: sessions reset on restart
    console.warn('[config] JWT_SECRET not set — using a random development secret');
  }
  return {
    production,
    port: Number(env.PORT || 4000),
    dbFile: env.DB_FILE || path.resolve(here, '../data/abc-cargo.db'),
    webDist: env.WEB_DIST || path.resolve(here, '../../web/dist'),
    jwtSecret,
    jwtTtl: env.JWT_TTL || '12h',
    trustProxy: env.TRUST_PROXY === '1',
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT || 20),
    // Demo online payments must never be on in production unless explicitly enabled.
    paymentsDemo: env.PAYMENTS_DEMO ? env.PAYMENTS_DEMO === '1' : !production,
    seedDemo: env.SEED_DEMO ? env.SEED_DEMO === '1' : !production,
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    mapTileHosts: (env.MAP_TILE_HOSTS || 'https://tile.openstreetmap.org').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
