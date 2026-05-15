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

const app = express();

// --- Security headers (OWASP A05) ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Babel Standalone requires unsafe-eval for in-browser JSX compilation.
      // To remove this directive, pre-compile the JSX files with a build tool.
      scriptSrc: ["'self'", 'unpkg.com', "'unsafe-eval'"],
      styleSrc: ["'self'", 'unpkg.com', 'fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc: ["'self'", 'fonts.gstatic.com'],
      // OpenStreetMap tiles + base64-encoded photos stored in state
      imgSrc: ["'self'", 'tile.openstreetmap.org', 'data:', 'blob:'],
      connectSrc: [
        "'self'",
        'cdn.jsdelivr.net',             // world-atlas GeoJSON for the map
        'nominatim.openstreetmap.org',  // city geocoding / search
      ],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
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
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Authentication required' });
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

// --- Auth endpoints ---
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required' });
  }
  const hash = process.env.APP_PASSWORD_HASH;
  if (!hash) {
    return res.status(503).json({ error: 'Authentication not configured on this server' });
  }
  const ok = await bcrypt.compare(password, hash);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  req.session.authenticated = true;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    res.json({ ok: true });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
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
}

app.get('/api/state', async (req, res) => {
  try {
    const result = await pool.query("SELECT data FROM app_state WHERE id = 'default'");
    const state = result.rows.length > 0 ? result.rows[0].data : null;
    const isAuth = !!(req.session && req.session.authenticated);
    res.json(isAuth ? state : redactForGuest(state));
  } catch (e) {
    console.error('GET /api/state:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/state', requireAuth, writeLimiter, async (req, res) => {
  if (!isValidStateBody(req.body)) {
    return res.status(400).json({ error: 'Invalid state payload' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      "SELECT data FROM app_state WHERE id = 'default' FOR UPDATE"
    );
    const base = existing.rows.length > 0 ? existing.rows[0].data : null;
    const merged = base ? mergeStates(base, req.body) : req.body;
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
