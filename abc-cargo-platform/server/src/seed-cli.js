// npm run seed -- [--reset]   Loads fictional demo data into DB_FILE (refuses in production).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { seedBase, seedDemo, DEMO_PASSWORD } from './seed.js';

const config = loadConfig();
if (config.production) { console.error('Refusing to seed demo data in production'); process.exit(1); }
if (process.argv.includes('--reset')) for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) fs.rmSync(f, { force: true });
fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
const db = openDb(config.dbFile);
seedBase(db);
if (db.get('SELECT COUNT(*) AS n FROM users').n) { console.log('Users already exist — use --reset to rebuild demo data'); process.exit(0); }
seedDemo(db);
console.log(`Demo data loaded into ${config.dbFile}. All demo users use password: ${DEMO_PASSWORD}`);
