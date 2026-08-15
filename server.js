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
      is_paid BOOLEAN DEFAULT false,
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
    CREATE TABLE IF NOT EXISTS client_connections (
      id SERIAL PRIMARY KEY,
      master_id VARCHAR(50) NOT NULL,
      client_uid VARCHAR(100) NOT NULL,
      account_name VARCHAR(255) DEFAULT '',
      broker VARCHAR(255) DEFAULT '',
      account_number VARCHAR(100) DEFAULT '',
      balance DOUBLE PRECISION DEFAULT 0,
      last_heartbeat TIMESTAMP DEFAULT NOW(),
      first_seen TIMESTAMP DEFAULT NOW(),
      is_active BOOLEAN DEFAULT true,
      UNIQUE(master_id, client_uid)
    );
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      amount DOUBLE PRECISION NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      method VARCHAR(50) DEFAULT '',
      reference VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Add columns if they don't exist (safe migration)
  try { await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false"); } catch(e){}
  try { await pool.query("ALTER TABLE client_connections ADD COLUMN IF NOT EXISTS balance DOUBLE PRECISION DEFAULT 0"); } catch(e){}

  console.log('✅ Database tables ready');
}

// ── Auth Helpers ──
function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name, master_id: user.master_id, is_paid: user.is_paid }, JWT_SECRET, { expiresIn: '30d' });
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

function paidMasterOnly(req, res, next) {
  if (req.user.role !== 'master') return res.status(403).json({ error: 'Master only' });
  // Check payment from DB
  pool.query('SELECT is_paid FROM users WHERE id = $1', [req.user.id])
    .then(r => {
      if (r.rows[0]?.is_paid) return next();
      return res.status(403).json({ error: 'Payment required. Activate your account ($200) to access this feature.' });
    }).catch(() => res.status(500).json({ error: 'Server error' }));
}

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
      'INSERT INTO users (email, password, name, role, master_id, is_paid) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, name, role, master_id, is_paid',
      [email, hash, name, role, master_id, true]
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
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role, master_id: user.master_id, is_paid: user.is_paid }, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  // Fetch fresh is_paid status
  try {
    const r = await pool.query('SELECT is_paid FROM users WHERE id = $1', [req.user.id]);
    req.user.is_paid = r.rows[0]?.is_paid || false;
  } catch(e) {}
  res.json({ user: req.user });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// ══════════════════════════════════════
//  MASTER DASHBOARD
// ══════════════════════════════════════

app.get('/api/master/dashboard', authMiddleware, masterOnly, async (req, res) => {
  try {
    // Get fresh payment status
    const userInfo = await pool.query('SELECT is_paid FROM users WHERE id = $1', [req.user.id]);
    const isPaid = userInfo.rows[0]?.is_paid || false;

    // Client connections with active/inactive status
    // Mark clients inactive if no heartbeat for 2 minutes
    await pool.query(
      "UPDATE client_connections SET is_active = false WHERE master_id = $1 AND last_heartbeat < NOW() - INTERVAL '2 minutes'",
      [req.user.master_id]
    );

    const clients = await pool.query(
      `SELECT * FROM client_connections WHERE master_id = $1 ORDER BY is_active DESC, last_heartbeat DESC`,
      [req.user.master_id]
    );

    const tradeCount = await pool.query(
      'SELECT COUNT(*) as count FROM trades WHERE master_id = $1', [req.user.master_id]
    );
    const recentTrades = await pool.query(
      'SELECT * FROM trades WHERE master_id = $1 ORDER BY created_at DESC LIMIT 20', [req.user.master_id]
    );

    const activeClients = clients.rows.filter(c => c.is_active).length;

    res.json({
      master_id: req.user.master_id,
      is_paid: isPaid,
      clients: clients.rows,
      client_count: clients.rows.length,
      active_count: activeClients,
      inactive_count: clients.rows.length - activeClients,
      trade_count: parseInt(tradeCount.rows[0].count),
      recent_trades: recentTrades.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════
//  EA FILE DOWNLOADS (.ex5 compiled)
// ══════════════════════════════════════

// Master downloads BOTH files (only if paid)
app.get('/api/download/master-ea', authMiddleware, paidMasterOnly, (req, res) => {
  const filePath = path.join(__dirname, 'ea', 'MasterEA.ex5');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="TradeBridge_MasterEA.ex5"`);
  res.sendFile(filePath);
});

app.get('/api/download/client-ea', authMiddleware, paidMasterOnly, (req, res) => {
  const filePath = path.join(__dirname, 'ea', 'ClientEA.ex5');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="TradeBridge_ClientEA.ex5"`);
  res.sendFile(filePath);
});

// ══════════════════════════════════════
//  CLIENT EA HEARTBEAT (tracks active/inactive)
// ══════════════════════════════════════

app.post('/heartbeat', async (req, res) => {
  try {
    const { master_id, client_uid, account_name, broker, account_number, balance } = req.body;
    if (!master_id || !client_uid) return res.status(400).json({ error: 'master_id and client_uid required' });

    // Verify master exists
    const master = await pool.query("SELECT id FROM users WHERE master_id = $1 AND role = 'master'", [master_id]);
    if (!master.rows.length) return res.status(404).json({ error: 'Master not found' });

    // Upsert client connection
    await pool.query(
      `INSERT INTO client_connections (master_id, client_uid, account_name, broker, account_number, balance, last_heartbeat, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), true)
       ON CONFLICT (master_id, client_uid) DO UPDATE SET
         last_heartbeat = NOW(),
         is_active = true,
         account_name = COALESCE(NULLIF($3,''), client_connections.account_name),
         broker = COALESCE(NULLIF($4,''), client_connections.broker),
         account_number = COALESCE(NULLIF($5,''), client_connections.account_number),
         balance = COALESCE($6, client_connections.balance)`,
      [master_id, client_uid, account_name || '', broker || '', account_number || '', parseFloat(balance) || 0]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════
//  TRADE COPIER ROUTES
// ══════════════════════════════════════

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
//  PAYMENT ROUTES
// ══════════════════════════════════════

// Submit payment proof
app.post('/api/payment/submit', authMiddleware, masterOnly, async (req, res) => {
  try {
    const { method, reference } = req.body;
    if (!method || !reference) return res.status(400).json({ error: 'Payment method and reference required' });

    await pool.query(
      'INSERT INTO payments (user_id, amount, status, method, reference) VALUES ($1, 200, $2, $3, $4)',
      [req.user.id, 'pending', method, reference]
    );
    res.json({ ok: true, message: 'Payment submitted for review. Your account will be activated within 24 hours.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: approve payment
app.post('/api/admin/approve-payment', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    await pool.query('UPDATE users SET is_paid = true WHERE id = $1', [user_id]);
    await pool.query("UPDATE payments SET status = 'approved' WHERE user_id = $1 AND status = 'pending'", [user_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: reject payment
app.post('/api/admin/reject-payment', async (req, res) => {
  try {
    const { user_id } = req.body;
    await pool.query("UPDATE payments SET status = 'rejected' WHERE user_id = $1 AND status = 'pending'", [user_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════
//  ADMIN
// ══════════════════════════════════════

app.get('/api/admin/stats', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const masters = await pool.query("SELECT COUNT(*) as count FROM users WHERE role='master'");
    const paidMasters = await pool.query("SELECT COUNT(*) as count FROM users WHERE role='master' AND is_paid=true");
    const clients = await pool.query("SELECT COUNT(*) as count FROM users WHERE role='client'");
    const trades = await pool.query('SELECT COUNT(*) as count FROM trades');
    const activeConns = await pool.query("SELECT COUNT(*) as count FROM client_connections WHERE is_active = true");
    const recent = await pool.query('SELECT * FROM trades ORDER BY created_at DESC LIMIT 15');
    const pendingPayments = await pool.query(
      `SELECT p.*, u.name, u.email, u.master_id FROM payments p JOIN users u ON u.id = p.user_id WHERE p.status = 'pending' ORDER BY p.created_at DESC`
    );
    const allMasters = await pool.query(
      `SELECT u.id, u.name, u.email, u.master_id, u.is_paid, u.created_at,
        (SELECT COUNT(*) FROM client_connections WHERE master_id = u.master_id) as total_clients,
        (SELECT COUNT(*) FROM client_connections WHERE master_id = u.master_id AND is_active = true) as active_clients
       FROM users u WHERE u.role = 'master' ORDER BY u.created_at DESC`
    );

    res.json({
      total_users: parseInt(users.rows[0].count),
      total_masters: parseInt(masters.rows[0].count),
      paid_masters: parseInt(paidMasters.rows[0].count),
      total_clients: parseInt(clients.rows[0].count),
      total_trades: parseInt(trades.rows[0].count),
      active_connections: parseInt(activeConns.rows[0].count),
      recent_trades: recent.rows,
      pending_payments: pendingPayments.rows,
      all_masters: allMasters.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Client routes (kept for backward compat) ──
app.get('/api/masters', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.master_id, u.bio, u.created_at,
        (SELECT COUNT(*) FROM subscriptions WHERE master_user_id = u.id) as client_count,
        (SELECT COUNT(*) FROM trades WHERE master_id = u.master_id) as trade_count
       FROM users u WHERE u.role = 'master' AND u.is_active = true AND u.is_paid = true ORDER BY u.created_at DESC`
    );
    res.json({ masters: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/subscribe', authMiddleware, async (req, res) => {
  try {
    const { master_user_id } = req.body;
    if (!master_user_id) return res.status(400).json({ error: 'Master ID required' });
    await pool.query(
      'INSERT INTO subscriptions (client_user_id, master_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, master_user_id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const { master_user_id } = req.body;
    await pool.query('DELETE FROM subscriptions WHERE client_user_id = $1 AND master_user_id = $2', [req.user.id, master_user_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/my-masters', authMiddleware, async (req, res) => {
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

app.post('/api/master/profile', authMiddleware, masterOnly, async (req, res) => {
  try {
    const { bio } = req.body;
    await pool.query('UPDATE users SET bio = $1 WHERE id = $2', [bio || '', req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});


// Admin: Expire/Deactivate master
app.post('/api/admin/toggle-master', async (req, res) => {
  try {
    const { user_id, is_active } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    await pool.query('UPDATE users SET is_active = $1 WHERE id = $2', [is_active !== false, user_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Toggle payment status directly
app.post('/api/admin/toggle-paid', async (req, res) => {
  try {
    const { user_id, is_paid } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    await pool.query('UPDATE users SET is_paid = $1 WHERE id = $2', [is_paid !== false, user_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Delete master account
app.post('/api/admin/delete-user', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    // Get master_id first
    const u = await pool.query('SELECT master_id FROM users WHERE id = $1', [user_id]);
    const mid = u.rows[0]?.master_id;
    if (mid) {
      await pool.query('DELETE FROM client_connections WHERE master_id = $1', [mid]);
      await pool.query('DELETE FROM trades WHERE master_id = $1', [mid]);
    }
    await pool.query('DELETE FROM subscriptions WHERE master_user_id = $1 OR client_user_id = $1', [user_id]);
    await pool.query('DELETE FROM payments WHERE user_id = $1', [user_id]);
    await pool.query('DELETE FROM users WHERE id = $1', [user_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get master detail with all clients
app.get('/api/admin/master/:id', async (req, res) => {
  try {
    const master = await pool.query(
      `SELECT u.*, 
        (SELECT COUNT(*) FROM client_connections WHERE master_id = u.master_id) as total_clients,
        (SELECT COUNT(*) FROM client_connections WHERE master_id = u.master_id AND is_active = true) as active_clients,
        (SELECT COUNT(*) FROM trades WHERE master_id = u.master_id) as trade_count
       FROM users u WHERE u.id = $1`, [req.params.id]
    );
    if (!master.rows.length) return res.status(404).json({ error: 'Not found' });

    // Update inactive clients
    await pool.query(
      "UPDATE client_connections SET is_active = false WHERE master_id = $1 AND last_heartbeat < NOW() - INTERVAL '2 minutes'",
      [master.rows[0].master_id]
    );

    const clients = await pool.query(
      'SELECT * FROM client_connections WHERE master_id = $1 ORDER BY is_active DESC, last_heartbeat DESC',
      [master.rows[0].master_id]
    );
    const trades = await pool.query(
      'SELECT * FROM trades WHERE master_id = $1 ORDER BY created_at DESC LIMIT 20',
      [master.rows[0].master_id]
    );
    const payments = await pool.query(
      'SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({
      master: master.rows[0],
      clients: clients.rows,
      trades: trades.rows,
      payments: payments.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get all clients
app.get('/api/admin/all-clients', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cc.*, u.name as master_name 
       FROM client_connections cc 
       LEFT JOIN users u ON u.master_id = cc.master_id 
       ORDER BY cc.last_heartbeat DESC LIMIT 100`
    );
    res.json({ clients: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Platform settings
app.get('/api/admin/settings', async (req, res) => {
  try {
    // Return platform config
    res.json({
      master_price: 200,
      auto_paid: true,
      heartbeat_timeout: 120,
      max_clients_per_master: 0,
      platform_name: 'TradeBridge',
      version: '3.8'
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
  app.listen(PORT, () => console.log(`🚀 TradeBridge running (no DB) on port ${PORT}`));
});
