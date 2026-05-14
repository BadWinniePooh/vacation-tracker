const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const path = require('path');

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
      connectSrc: ["'self'"],
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
  windowMs: 60 * 1000,   // 1 minute
  max: 60,               // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,               // writes are heavier; tighter cap
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

app.use('/api/', apiLimiter);

// 10 MB cap — accommodates reasonable base64-photo payloads without enabling trivial DoS
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Limit concurrent SSE connections to prevent resource exhaustion
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
    res.json(result.rows.length > 0 ? result.rows[0].data : null);
  } catch (e) {
    console.error('GET /api/state:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/state', writeLimiter, async (req, res) => {
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
