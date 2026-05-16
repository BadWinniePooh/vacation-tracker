#!/usr/bin/env node
// Generates a bcrypt-12 hash for use as APP_PASSWORD_HASH in .env.
// Usage: node scripts/gen-password-hash.js <password>
//    or: npm run gen-hash -- <password>
const bcrypt = require('bcryptjs');
const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/gen-password-hash.js <your-password>');
  process.exit(1);
}
// Single quotes prevent Docker Compose from interpolating $ in the bcrypt hash.
console.log(`APP_PASSWORD_HASH='${bcrypt.hashSync(password, 12)}'`);
