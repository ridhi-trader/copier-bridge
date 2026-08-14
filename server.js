const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tradebridge_secret_2026';

// ── Database ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Init DB Tables ──
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('master','client')),
      master_id VARCHAR(50) UNIQUE,
      bio TEXT DEFAULT '',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      client_user_id INTEGER REFERENCES users(id),
      master_user_id INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(client_user_id, master_user_id)
    );
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      master_id VARCHAR(50) NOT NULL,
      symbol VARCHAR(30),
      action VARCHAR(20),
      volume DOUBLE PRECISION,
      price DOUBLE PRECISION,
      sl DOUBLE PRECISION DEFAULT 0,
      tp DOUBLE PRECISION DEFAULT 0,
      ticket BIGINT,
      comment TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database tables ready');
}

// ── Auth Helpers ──
function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name, master_id: user.master_id }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function masterOnly(req, res, next) {
  if (req.user.role !== 'master') return res.status(403).json({ error: 'Master only' });
  next();
}

function clientOnly(req, res, next) {
  if (req.user.role !== 'client') return res.status(403).json({ error: 'Client only' });
  next();
}

// ── Generate unique Master ID ──
function genMasterID() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = 'TB-';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ══════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════

app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name || !role) return res.status(400).json({ error: 'All fields required' });
    if (!['master', 'client'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const master_id = role === 'master' ? genMasterID() : null;

    const result = await pool.query(
      'INSERT INTO users (email, password, name, role, master_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, master_id',
      [email, hash, name, role, master_id]
    );

    const user = result.rows[0];
    const token = generateToken(user);
    res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 3600000 });
    res.json({ ok: true, user, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!result.rows.length) return res.status(400).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = generateToken(user);
    res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 3600000 });
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role, master_id: user.master_id }, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// ══════════════════════════════════════
//  MASTER ROUTES
// ══════════════════════════════════════

// Master dashboard data
app.get('/api/master/dashboard', authMiddleware, masterOnly, async (req, res) => {
  try {
    const subs = await pool.query(
      `SELECT u.name, u.email, s.created_at FROM subscriptions s
       JOIN users u ON u.id = s.client_user_id
       WHERE s.master_user_id = $1 ORDER BY s.created_at DESC`, [req.user.id]
    );
    const tradeCount = await pool.query(
      'SELECT COUNT(*) as count FROM trades WHERE master_id = $1', [req.user.master_id]
    );
    const recentTrades = await pool.query(
      'SELECT * FROM trades WHERE master_id = $1 ORDER BY created_at DESC LIMIT 20', [req.user.master_id]
    );
    res.json({
      master_id: req.user.master_id,
      clients: subs.rows,
      client_count: subs.rows.length,
      trade_count: parseInt(tradeCount.rows[0].count),
      recent_trades: recentTrades.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update master profile/bio
app.post('/api/master/profile', authMiddleware, masterOnly, async (req, res) => {
  try {
    const { bio } = req.body;
    await pool.query('UPDATE users SET bio = $1 WHERE id = $2', [bio || '', req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════
//  CLIENT ROUTES
// ══════════════════════════════════════

// List available masters
app.get('/api/masters', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.master_id, u.bio, u.created_at,
        (SELECT COUNT(*) FROM subscriptions WHERE master_user_id = u.id) as client_count,
        (SELECT COUNT(*) FROM trades WHERE master_id = u.master_id) as trade_count
       FROM users u WHERE u.role = 'master' AND u.is_active = true ORDER BY u.created_at DESC`
    );
    res.json({ masters: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Subscribe to a master
app.post('/api/subscribe', authMiddleware, clientOnly, async (req, res) => {
  try {
    const { master_user_id } = req.body;
    if (!master_user_id) return res.status(400).json({ error: 'Master ID required' });

    const master = await pool.query('SELECT id, master_id FROM users WHERE id = $1 AND role = $2', [master_user_id, 'master']);
    if (!master.rows.length) return res.status(404).json({ error: 'Master not found' });

    await pool.query(
      'INSERT INTO subscriptions (client_user_id, master_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, master_user_id]
    );
    res.json({ ok: true, master_id: master.rows[0].master_id });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Unsubscribe from a master
app.post('/api/unsubscribe', authMiddleware, clientOnly, async (req, res) => {
  try {
    const { master_user_id } = req.body;
    await pool.query('DELETE FROM subscriptions WHERE client_user_id = $1 AND master_user_id = $2', [req.user.id, master_user_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Client's subscribed masters
app.get('/api/my-masters', authMiddleware, clientOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.master_id, u.bio,
        (SELECT COUNT(*) FROM trades WHERE master_id = u.master_id) as trade_count
       FROM subscriptions s JOIN users u ON u.id = s.master_user_id
       WHERE s.client_user_id = $1`, [req.user.id]
    );
    res.json({ masters: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════
//  EA FILE DOWNLOADS
// ══════════════════════════════════════

app.get('/api/download/master-ea', authMiddleware, masterOnly, (req, res) => {
  const filePath = path.join(__dirname, 'ea', 'MasterEA.mq5');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  // Read file and inject master_id
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace('__MASTER_ID__', req.user.master_id);
  
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="TradeBridge_Master_${req.user.master_id}.mq5"`);
  res.send(content);
});

app.get('/api/download/client-ea', authMiddleware, clientOnly, (req, res) => {
  const masterId = req.query.master_id;
  if (!masterId) return res.status(400).json({ error: 'master_id required' });

  const filePath = path.join(__dirname, 'ea', 'ClientEA.mq5');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace('__MASTER_ID__', masterId);
  
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="TradeBridge_Client_${masterId}.mq5"`);
  res.send(content);
});

// ══════════════════════════════════════
//  TRADE COPIER ROUTES (existing logic)
// ══════════════════════════════════════

// Master EA posts trade
app.post('/trade', async (req, res) => {
  try {
    const { master_id, symbol, action, volume, price, sl, tp, ticket, comment } = req.body;
    if (!master_id || !symbol || !action) return res.status(400).json({ error: 'Missing fields' });

    await pool.query(
      `INSERT INTO trades (master_id, symbol, action, volume, price, sl, tp, ticket, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [master_id, symbol, action, parseFloat(volume)||0, parseFloat(price)||0, parseFloat(sl)||0, parseFloat(tp)||0, parseInt(ticket)||0, comment||'']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Trade post error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Client EA polls for trades
app.get('/poll', async (req, res) => {
  try {
    const { master_id, since } = req.query;
    if (!master_id) return res.status(400).json({ error: 'master_id required' });

    const sinceId = parseInt(since || '0') || 0;
    const result = await pool.query(
      'SELECT * FROM trades WHERE master_id = $1 AND id > $2 ORDER BY id ASC LIMIT 50',
      [master_id, sinceId]
    );
    res.json({ trades: result.rows });
  } catch (err) {
    console.error('Poll error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════
//  ADMIN (open access)
// ══════════════════════════════════════

app.get('/api/admin/stats', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const masters = await pool.query("SELECT COUNT(*) as count FROM users WHERE role='master'");
    const clients = await pool.query("SELECT COUNT(*) as count FROM users WHERE role='client'");
    const trades = await pool.query('SELECT COUNT(*) as count FROM trades');
    const recent = await pool.query('SELECT * FROM trades ORDER BY created_at DESC LIMIT 15');
    res.json({
      total_users: parseInt(users.rows[0].count),
      total_masters: parseInt(masters.rows[0].count),
      total_clients: parseInt(clients.rows[0].count),
      total_trades: parseInt(trades.rows[0].count),
      recent_trades: recent.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Page Routes ──
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Start ──
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 TradeBridge running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  // Start anyway for non-DB routes
  app.listen(PORT, () => console.log(`🚀 TradeBridge running (no DB) on port ${PORT}`));
});
