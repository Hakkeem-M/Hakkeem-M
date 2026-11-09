import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { seedBase, seedDemo } from './seed.js';

const config = loadConfig();
fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
const db = openDb(config.dbFile);
seedBase(db);

const users = db.get('SELECT COUNT(*) AS n FROM users').n;
if (!users) {
  if (config.seedDemo) {
    seedDemo(db);
    console.log('[seed] Demo data loaded (see README for demo logins)');
  } else if (config.adminEmail && config.adminPassword) {
    db.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Administrator', ?, ?, 'ADMIN')",
      config.adminEmail, bcrypt.hashSync(config.adminPassword, 12));
    console.log(`[seed] Initial admin created: ${config.adminEmail}`);
  } else {
    console.warn('[seed] No users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD to create the first administrator.');
  }
}

const app = createApp({ db, config });
const server = app.listen(config.port, () => {
  console.log(`ABC Cargo platform listening on http://localhost:${config.port}`);
});
const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
