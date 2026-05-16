const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

// Fail fast with a clear message if required environment variables are absent.
const REQUIRED_ENV = ['DATABASE_URL', 'SESSION_SECRET', 'APP_PASSWORD_HASH'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env, fill in the values, and restart.');
  process.exit(1);
}

// Detect bcrypt hashes mangled by Docker Compose $ interpolation.
// Docker Compose expands $VAR in .env values unless they are single-quoted.
// A bcrypt hash always starts with $2b$ or $2a$; anything else means the
// value was silently truncated/mangled and bcrypt.compare() will always fail.
if (!process.env.APP_PASSWORD_HASH.startsWith('$2')) {
  console.error('APP_PASSWORD_HASH does not look like a valid bcrypt hash (expected to start with $2b$).');
  console.error('Docker Compose interpolates $ in .env values, silently mangling the hash.');
  console.error("Wrap the value in single quotes in your .env file:");
  console.error("  APP_PASSWORD_HASH='$2b$12$...'");
  console.error("Run 'npm run gen-hash -- yourpassword' to regenerate in the correct format.");
  process.exit(1);
}

function mergeStates(base, incoming) {
  const users = { ...base.users };
  for (const [id, u] of Object.entries(incoming.users || {})) {
    if (!users[id] || (u._ts || 0) >= (users[id]._ts || 0)) users[id] = u;
  }

  const cities = { ...base.cities };
  for (const [k, c] of Object.entries(incoming.cities || {})) {
    if (!cities[k] || (c._ts || 0) >= (cities[k]._ts || 0)) cities[k] = c;
  }

  const ctById = {};
  for (const t of [...(base.customTypes || []), ...(incoming.customTypes || [])]) {
    if (!ctById[t.id] || (t._ts || 0) >= (ctById[t.id]._ts || 0)) ctById[t.id] = t;
  }

  const countries = {};
  for (const c of Object.values(cities)) {
    if (!countries[c.country]) countries[c.country] = { cities: [] };
    if (!countries[c.country].cities.includes(c.name)) countries[c.country].cities.push(c.name);
  }

  return { ...incoming, users, cities, countries, customTypes: Object.values(ctById) };
}

// Strip type and participants from every city so guests can't see them
function redactForGuest(state) {
  if (!state) return state;
  const cities = {};
  for (const [k, c] of Object.entries(state.cities || {})) {
    // eslint-disable-next-line no-unused-vars
    const { type: _t, participants: _p, ...pub } = c;
    cities[k] = pub;
  }
  return { ...state, cities };
}

// Filter state to only include travellers linked to the user and cities they participate in.
function redactForUser(state, travellerIds) {
  if (!state) return state;
  const tids = new Set(travellerIds);
  const users = {};
  for (const [id, u] of Object.entries(state.users || {})) {
    if (tids.has(id)) users[id] = u;
  }
  const cities = {};
  for (const [k, c] of Object.entries(state.cities || {})) {
    if ((c.participants || []).some(p => tids.has(p))) cities[k] = c;
  }
  const countries = {};
  for (const c of Object.values(cities)) {
    if (!countries[c.country]) countries[c.country] = { cities: [] };
    if (!countries[c.country].cities.includes(c.name)) countries[c.country].cities.push(c.name);
  }
  return { ...state, users, cities, countries };
}

// Merge incoming state from a regular (non-admin) user.
// Enforces that users may only modify their own linked travellers and
// cities they participate in; other users' data in the base is preserved.
// userId is req.session.userId (integer) used to check traveller ownership.
function mergeStatesForUser(base, incoming, travellerIds, userId) {
  const tids = new Set(travellerIds);

  const users = { ...base.users };
  for (const [id, u] of Object.entries(incoming.users || {})) {
    if (!tids.has(id)) continue;
    const baseUser = users[id];
    if (!baseUser) {
      // New traveller the user just created — accepted because they're linked.
      // Preserve whatever ownerId the client set (validated by claim endpoint).
      users[id] = u;
      continue;
    }
    if ((u._ts || 0) >= (baseUser._ts || 0)) {
      // Only the owner may update traveller properties (name, color, etc.).
      // Legacy travellers without ownerId are treated as editable (backward compat).
      const isOwner = !baseUser.ownerId || baseUser.ownerId === userId;
      if (isOwner) {
        // Keep the stored ownerId authoritative — client cannot overwrite it.
        users[id] = { ...u, ownerId: baseUser.ownerId ?? u.ownerId };
      }
    }
  }

  const cities = { ...base.cities };
  // Apply updates from incoming (only for cities with linked-traveller involvement)
  for (const [k, c] of Object.entries(incoming.cities || {})) {
    const baseCity = cities[k];
    if (!baseCity) {
      // New city: accept only if a linked traveller is listed as participant
      if ((c.participants || []).some(p => tids.has(p))) cities[k] = c;
    } else if ((c._ts || 0) >= (baseCity._ts || 0)) {
      // Updated city: non-linked participants from base are always preserved
      const nonLinked = (baseCity.participants || []).filter(p => !tids.has(p));
      const linked = (c.participants || []).filter(p => tids.has(p));
      const merged = [...new Set([...nonLinked, ...linked])];
      if (merged.length > 0) {
        cities[k] = { ...c, participants: merged };
      } else {
        delete cities[k];
      }
    }
  }
  // Cities absent from incoming: if user had linked participants there, remove them
  for (const [k, baseCity] of Object.entries(base.cities || {})) {
    if (cities[k] && !(k in incoming.cities)) {
      const linkedParts = (baseCity.participants || []).filter(p => tids.has(p));
      if (linkedParts.length > 0) {
        const nonLinked = (baseCity.participants || []).filter(p => !tids.has(p));
        if (nonLinked.length === 0) {
          delete cities[k];
        } else {
          cities[k] = { ...baseCity, participants: nonLinked };
        }
      }
    }
  }

  const ctById = {};
  for (const t of [...(base.customTypes || []), ...(incoming.customTypes || [])]) {
    if (!ctById[t.id] || (t._ts || 0) >= (ctById[t.id]._ts || 0)) ctById[t.id] = t;
  }

  const countries = {};
  for (const c of Object.values(cities)) {
    if (!countries[c.country]) countries[c.country] = { cities: [] };
    if (!countries[c.country].cities.includes(c.name)) countries[c.country].cities.push(c.name);
  }

  return { ...incoming, users, cities, countries, customTypes: Object.values(ctById) };
}

// Basic structural validation — reject payloads that are clearly not app state
function isValidStateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.v !== 4) return false;
  if (typeof body.cities !== 'object' || Array.isArray(body.cities)) return false;
  if (typeof body.users !== 'object' || Array.isArray(body.users)) return false;
  return true;
}

// Restrict to alphanumeric + hyphens, max 64 chars
function sanitiseClientId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9\-]/g, '').slice(0, 64);
}

// Restrict to alphanumeric + hyphens + underscores, 2–32 chars
function sanitiseUsername(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 32);
}

// Traveller IDs are short random base-36 strings from the client
function sanitiseTravellerId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 32);
}

const app = express();

// --- Security headers (OWASP A05) ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Babel Standalone requires unsafe-eval for in-browser JSX compilation.
      // Babel Standalone fetches .jsx files via XHR, transpiles them, then
      // injects the result as inline <script> blocks — both 'unsafe-eval'
      // (for eval-like execution) and 'unsafe-inline' (for inline injection)
      // are required. To remove both, pre-compile the JSX with a build tool.
      scriptSrc: ["'self'", 'https://unpkg.com', "'unsafe-eval'", "'unsafe-inline'"],
      styleSrc: ["'self'", 'https://unpkg.com', 'https://fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // OpenStreetMap tiles + base64-encoded photos stored in state
      imgSrc: ["'self'", 'https://tile.openstreetmap.org', 'data:', 'blob:'],
      connectSrc: [
        "'self'",
        'https://cdn.jsdelivr.net',
        'https://nominatim.openstreetmap.org',
      ],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      // Helmet enables upgrade-insecure-requests by default, which tells the
      // browser to promote every http:// subresource to https://. On a plain
      // HTTP private deployment this breaks all local file loads. Traefik
      // already enforces HTTPS at the network level for public deployments, so
      // the app does not need to repeat the instruction.
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false, // Leaflet cross-origin tiles need this off
}));

// --- Rate limiting (OWASP A04) ---
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Tighter limit on login to slow brute-force (OWASP A07)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts' },
});

app.use('/api/', apiLimiter);

// 10 MB cap — accommodates reasonable base64-photo payloads without enabling trivial DoS
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// --- Session middleware ---
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

app.use(express.static(path.join(__dirname, 'public')));

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Authentication required' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

// --- SSE clients ---
const MAX_SSE_CLIENTS = 100;
const clients = new Set();
setInterval(() => { for (const c of clients) c.write(': keepalive\n\n'); }, 25000);

app.get('/api/events', (req, res) => {
  if (clients.size >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ error: 'Too many active connections' });
  }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Fetch the traveller IDs linked to a given user — returns a string array.
async function getTravellerIds(userId) {
  const r = await pool.query(
    'SELECT traveller_id FROM user_traveller_links WHERE user_id = $1',
    [userId]
  );
  return r.rows.map(row => row.traveller_id);
}

// Replace all traveller links for a user atomically (inside an existing client).
async function setTravellerIds(client, userId, rawIds) {
  const ids = (Array.isArray(rawIds) ? rawIds : [])
    .map(sanitiseTravellerId)
    .filter(Boolean);
  await client.query('DELETE FROM user_traveller_links WHERE user_id = $1', [userId]);
  for (const tid of ids) {
    await client.query(
      'INSERT INTO user_traveller_links (user_id, traveller_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, tid]
    );
  }
  return ids;
}

// --- Auth endpoints ---
app.get('/api/auth/status', async (req, res) => {
  if (!(req.session && req.session.userId)) {
    return res.json({ authenticated: false });
  }
  try {
    const travellerIds = await getTravellerIds(req.session.userId);
    res.json({
      authenticated: true,
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
      travellerIds,
    });
  } catch (e) {
    console.error('GET /api/auth/status:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Username required' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required' });
  }
  try {
    const result = await pool.query(
      'SELECT id, username, password_hash, role FROM app_users WHERE username = $1',
      [sanitiseUsername(username)]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    await new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));
    const travellerIds = await getTravellerIds(user.id);
    res.json({ ok: true, id: user.id, username: user.username, role: user.role, travellerIds });
  } catch (e) {
    console.error('POST /api/auth/login:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// Change own password (any authenticated user)
app.put('/api/auth/password', requireAuth, writeLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || typeof currentPassword !== 'string') {
    return res.status(400).json({ error: 'Current password required' });
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  try {
    const result = await pool.query(
      'SELECT password_hash FROM app_users WHERE id = $1',
      [req.session.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE app_users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/auth/password:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Manage own traveller links — any authenticated user can link/unlink themselves
app.get('/api/auth/travellers', requireAuth, async (req, res) => {
  try {
    res.json(await getTravellerIds(req.session.userId));
  } catch (e) {
    console.error('GET /api/auth/travellers:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/auth/travellers', requireAuth, writeLimiter, async (req, res) => {
  const { travellerIds } = req.body || {};
  if (!Array.isArray(travellerIds)) {
    return res.status(400).json({ error: 'travellerIds must be an array' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = await setTravellerIds(client, req.session.userId, travellerIds);
    await client.query('COMMIT');
    res.json({ ok: true, travellerIds: ids });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /api/auth/travellers:', e.message);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// --- Admin: user management ---
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.role, u.created_at,
        ARRAY_REMOVE(ARRAY_AGG(l.traveller_id), NULL) AS traveller_ids
      FROM app_users u
      LEFT JOIN user_traveller_links l ON l.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at
    `);
    res.json(result.rows.map(r => ({ ...r, traveller_ids: r.traveller_ids || [] })));
  } catch (e) {
    console.error('GET /api/admin/users:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/admin/users', requireAuth, requireAdmin, writeLimiter, async (req, res) => {
  const { username, password, role = 'user', travellerIds = [] } = req.body || {};
  const clean = sanitiseUsername(username || '');
  if (clean.length < 2) {
    return res.status(400).json({ error: 'Username must be 2–32 alphanumeric characters' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin or user' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 12);
    const result = await client.query(
      'INSERT INTO app_users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at',
      [clean, hash, role]
    );
    const newUser = result.rows[0];
    const linkedIds = await setTravellerIds(client, newUser.id, travellerIds);
    await client.query('COMMIT');
    res.status(201).json({ ...newUser, traveller_ids: linkedIds });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    console.error('POST /api/admin/users:', e.message);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, writeLimiter, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  const { password, role, travellerIds } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id, role FROM app_users WHERE id = $1', [id]);
    if (!existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const hash = await bcrypt.hash(password, 12);
      await client.query('UPDATE app_users SET password_hash = $1 WHERE id = $2', [hash, id]);
    }

    if (role !== undefined) {
      if (!['admin', 'user'].includes(role)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Role must be admin or user' });
      }
      // Prevent demoting the last admin
      if (role !== 'admin' && existing.rows[0].role === 'admin') {
        const cnt = await client.query("SELECT COUNT(*) FROM app_users WHERE role = 'admin'");
        if (parseInt(cnt.rows[0].count, 10) <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cannot demote the last admin' });
        }
      }
      await client.query('UPDATE app_users SET role = $1 WHERE id = $2', [role, id]);
    }

    let linkedIds;
    if (travellerIds !== undefined) {
      linkedIds = await setTravellerIds(client, id, travellerIds);
    } else {
      linkedIds = await getTravellerIds(id);
    }

    await client.query('COMMIT');
    const result = await pool.query(
      'SELECT id, username, role, created_at FROM app_users WHERE id = $1', [id]
    );
    res.json({ ...result.rows[0], traveller_ids: linkedIds });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /api/admin/users/:id:', e.message);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, writeLimiter, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  try {
    const user = await pool.query('SELECT role FROM app_users WHERE id = $1', [id]);
    if (!user.rows.length) return res.status(404).json({ error: 'User not found' });

    if (user.rows[0].role === 'admin') {
      const cnt = await pool.query("SELECT COUNT(*) FROM app_users WHERE role = 'admin'");
      if (parseInt(cnt.rows[0].count, 10) <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin' });
      }
    }

    // Traveller links are cleaned up automatically via ON DELETE CASCADE
    await pool.query('DELETE FROM app_users WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/admin/users/:id:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Traveller ownership & sharing ---

// Claim ownership of a newly-created traveller (must not already be claimed).
// Also ensures the caller is linked to the traveller.
app.post('/api/travellers/:id/claim', requireAuth, writeLimiter, async (req, res) => {
  const travellerId = sanitiseTravellerId(req.params.id);
  if (!travellerId) return res.status(400).json({ error: 'Invalid traveller ID' });
  try {
    const r = await pool.query(
      'INSERT INTO traveller_owners (traveller_id, owner_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING owner_user_id',
      [travellerId, req.session.userId]
    );
    if (r.rows.length === 0) {
      // Already claimed — verify it's by this user
      const existing = await pool.query('SELECT owner_user_id FROM traveller_owners WHERE traveller_id = $1', [travellerId]);
      if (existing.rows.length && existing.rows[0].owner_user_id !== req.session.userId) {
        return res.status(403).json({ error: 'Traveller already owned by another user' });
      }
    }
    await pool.query(
      'INSERT INTO user_traveller_links (user_id, traveller_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.session.userId, travellerId]
    );
    res.json({ ok: true, ownerId: req.session.userId });
  } catch (e) {
    console.error('POST /api/travellers/:id/claim:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get sharing info (linked users) for a traveller. Only the owner may call this.
app.get('/api/travellers/:id/sharing', requireAuth, async (req, res) => {
  const travellerId = sanitiseTravellerId(req.params.id);
  if (!travellerId) return res.status(400).json({ error: 'Invalid traveller ID' });
  try {
    const ownership = await pool.query('SELECT owner_user_id FROM traveller_owners WHERE traveller_id = $1', [travellerId]);
    if (!ownership.rows.length || ownership.rows[0].owner_user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Only the traveller owner can view sharing' });
    }
    const links = await pool.query(
      `SELECT u.id, u.username FROM user_traveller_links l
       JOIN app_users u ON u.id = l.user_id
       WHERE l.traveller_id = $1`,
      [travellerId]
    );
    res.json({
      ownerId: req.session.userId,
      sharedWith: links.rows.map(r => ({ id: r.id, username: r.username, isOwner: r.id === req.session.userId })),
    });
  } catch (e) {
    console.error('GET /api/travellers/:id/sharing:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Share a traveller with another user by username (owner only).
app.post('/api/travellers/:id/share', requireAuth, writeLimiter, async (req, res) => {
  const travellerId = sanitiseTravellerId(req.params.id);
  if (!travellerId) return res.status(400).json({ error: 'Invalid traveller ID' });
  const { username } = req.body || {};
  if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Username required' });
  try {
    const ownership = await pool.query('SELECT owner_user_id FROM traveller_owners WHERE traveller_id = $1', [travellerId]);
    if (!ownership.rows.length || ownership.rows[0].owner_user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Only the traveller owner can share it' });
    }
    const target = await pool.query('SELECT id, username FROM app_users WHERE username = $1', [sanitiseUsername(username)]);
    if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
    const targetUser = target.rows[0];
    if (targetUser.id === req.session.userId) return res.status(400).json({ error: 'Already the owner' });
    await pool.query(
      'INSERT INTO user_traveller_links (user_id, traveller_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [targetUser.id, travellerId]
    );
    res.json({ ok: true, user: { id: targetUser.id, username: targetUser.username } });
  } catch (e) {
    console.error('POST /api/travellers/:id/share:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Revoke another user's access to a traveller (owner only, cannot remove own access).
app.delete('/api/travellers/:id/share/:userId', requireAuth, writeLimiter, async (req, res) => {
  const travellerId = sanitiseTravellerId(req.params.id);
  const targetUserId = parseInt(req.params.userId, 10);
  if (!travellerId || !Number.isInteger(targetUserId)) return res.status(400).json({ error: 'Invalid parameters' });
  if (targetUserId === req.session.userId) return res.status(400).json({ error: 'Cannot revoke your own access as owner' });
  try {
    const ownership = await pool.query('SELECT owner_user_id FROM traveller_owners WHERE traveller_id = $1', [travellerId]);
    if (!ownership.rows.length || ownership.rows[0].owner_user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Only the traveller owner can remove sharing' });
    }
    await pool.query('DELETE FROM user_traveller_links WHERE user_id = $1 AND traveller_id = $2', [targetUserId, travellerId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/travellers/:id/share/:userId:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete a traveller entirely (owner or admin only).
// Removes it from the shared state, all links, and the ownership record.
app.delete('/api/travellers/:id', requireAuth, writeLimiter, async (req, res) => {
  const travellerId = sanitiseTravellerId(req.params.id);
  if (!travellerId) return res.status(400).json({ error: 'Invalid traveller ID' });
  const isAdmin = req.session.role === 'admin';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!isAdmin) {
      const ownership = await client.query('SELECT owner_user_id FROM traveller_owners WHERE traveller_id = $1', [travellerId]);
      if (!ownership.rows.length || ownership.rows[0].owner_user_id !== req.session.userId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the traveller owner can delete it' });
      }
    }
    // Remove from shared state
    const stateResult = await client.query("SELECT data FROM app_state WHERE id = 'default' FOR UPDATE");
    if (stateResult.rows.length > 0 && stateResult.rows[0].data) {
      const state = stateResult.rows[0].data;
      const users = { ...(state.users || {}) };
      delete users[travellerId];
      const cities = {};
      for (const [k, c] of Object.entries(state.cities || {})) {
        const p = (c.participants || []).filter(x => x !== travellerId);
        if (p.length > 0) cities[k] = { ...c, participants: p };
      }
      const countries = {};
      for (const c of Object.values(cities)) {
        if (!countries[c.country]) countries[c.country] = { cities: [] };
        if (!countries[c.country].cities.includes(c.name)) countries[c.country].cities.push(c.name);
      }
      await client.query(
        "UPDATE app_state SET data = $1, updated_at = NOW() WHERE id = 'default'",
        [{ ...state, users, cities, countries }]
      );
    }
    await client.query('DELETE FROM user_traveller_links WHERE traveller_id = $1', [travellerId]);
    await client.query('DELETE FROM traveller_owners WHERE traveller_id = $1', [travellerId]);
    await client.query('COMMIT');
    const clientId = sanitiseClientId(req.headers['x-client-id'] || '');
    for (const c of clients) c.write(`data: ${JSON.stringify({ clientId })}\n\n`);
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/travellers/:id:', e.message);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// --- App state ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Each row links a login account to a traveller ID from the map state.
  // ON DELETE CASCADE keeps this clean when users are deleted.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_traveller_links (
      user_id    INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      traveller_id TEXT  NOT NULL,
      PRIMARY KEY (user_id, traveller_id)
    )
  `);

  // Tracks who created (owns) each traveller. The owner is the only account
  // allowed to share the traveller with others, revoke access, or delete it.
  // ON DELETE CASCADE removes ownership when the owning account is deleted.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS traveller_owners (
      traveller_id  TEXT    PRIMARY KEY,
      owner_user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE
    )
  `);

  // Seed the admin user from env vars on first run (no admin in DB yet).
  // APP_ADMIN_USERNAME defaults to 'admin'. Going forward, manage users via
  // the in-app admin panel — APP_PASSWORD_HASH is only used for this seed.
  const adminExists = await pool.query("SELECT id FROM app_users WHERE role = 'admin' LIMIT 1");
  if (adminExists.rows.length === 0) {
    const adminUsername = sanitiseUsername(process.env.APP_ADMIN_USERNAME || 'admin');
    await pool.query(
      `INSERT INTO app_users (username, password_hash, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (username) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash`,
      [adminUsername, process.env.APP_PASSWORD_HASH]
    );
    console.log(`Admin user '${adminUsername}' created from APP_PASSWORD_HASH.`);
  }
}

app.get('/api/state', async (req, res) => {
  try {
    const result = await pool.query("SELECT data FROM app_state WHERE id = 'default'");
    const state = result.rows.length > 0 ? result.rows[0].data : null;
    const isAuth = !!(req.session && req.session.userId);
    if (!isAuth) return res.json(redactForGuest(state));
    // Admins receive the full state so the user-management panel can list all travellers.
    // Regular users receive only their linked travellers and the cities they participate in.
    if (req.session.role === 'admin') return res.json(state);
    const travellerIds = await getTravellerIds(req.session.userId);
    res.json(redactForUser(state, travellerIds));
  } catch (e) {
    console.error('GET /api/state:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/state', requireAuth, writeLimiter, async (req, res) => {
  if (!isValidStateBody(req.body)) {
    return res.status(400).json({ error: 'Invalid state payload' });
  }

  const isAdmin = req.session.role === 'admin';
  // Fetch linked travellers outside the transaction (read-only, no locking needed)
  const travellerIds = isAdmin ? null : await getTravellerIds(req.session.userId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      "SELECT data FROM app_state WHERE id = 'default' FOR UPDATE"
    );
    const base = existing.rows.length > 0 ? existing.rows[0].data : null;
    const merged = base
      ? (isAdmin ? mergeStates(base, req.body) : mergeStatesForUser(base, req.body, travellerIds, req.session.userId))
      : req.body;
    await client.query(
      `INSERT INTO app_state (id, data, updated_at) VALUES ('default', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [merged]
    );
    await client.query('COMMIT');
    const clientId = sanitiseClientId(req.headers['x-client-id'] || '');
    const msg = `data: ${JSON.stringify({ clientId })}\n\n`;
    for (const c of clients) c.write(msg);
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /api/state:', e.message);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

initDB()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Atlas listening on port ${PORT}`));
  })
  .catch(err => {
    console.error('DB init failed:', err.message);
    process.exit(1);
  });
