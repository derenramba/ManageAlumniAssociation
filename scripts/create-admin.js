'use strict';
/**
 * Creates the initial Main Administrator if no administrators exist yet.
 * Usage:
 *   node scripts/create-admin.js <username> "<Full Name>" [password]
 * When run by the server on first start, uses INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD
 * or generates a random password and prints it once.
 */
const crypto = require('crypto');
const db = require('../src/db');
const { hashPassword } = require('../src/lib/security');
const { ROLES } = require('../src/lib/permissions');

function createAdmin({ username, fullName, password, role = 'main_admin', isDemo = 0 }) {
  return db.get().prepare('INSERT INTO admin_users (username, full_name, password_hash, role, permissions, is_demo) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, fullName, hashPassword(password), role, JSON.stringify(ROLES[role].permissions), isDemo).lastInsertRowid;
}

function ensureInitialAdmin() {
  const n = db.get().prepare('SELECT COUNT(*) n FROM admin_users').get().n;
  if (n > 0) return;
  const username = process.env.INITIAL_ADMIN_USERNAME || 'admin';
  const password = process.env.INITIAL_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url') + '7a';
  createAdmin({ username, fullName: 'Main Administrator', password });
  console.log('==================================================================');
  console.log(' Initial Main Administrator account created');
  console.log(`   Username: ${username}`);
  if (!process.env.INITIAL_ADMIN_PASSWORD) console.log(`   Password: ${password}   (shown once — change it after signing in)`);
  console.log('==================================================================');
}

if (require.main === module) {
  const [username, fullName, password] = process.argv.slice(2);
  if (!username || !fullName) {
    console.error('Usage: node scripts/create-admin.js <username> "<Full Name>" [password]');
    process.exit(1);
  }
  const pw = password || crypto.randomBytes(9).toString('base64url') + '7a';
  try {
    createAdmin({ username, fullName, password: pw });
    console.log(`Main Administrator "${username}" created.${password ? '' : ` Password: ${pw}`}`);
  } catch (e) {
    console.error('Could not create admin:', e.message);
    process.exit(1);
  }
}

module.exports = { createAdmin, ensureInitialAdmin };
