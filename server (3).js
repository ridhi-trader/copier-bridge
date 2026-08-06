// ==================================================================
//  COPIER BRIDGE  -  Server (with live Admin Panel)
//  Master EA -> POST /trade   |  Client EA -> GET /poll
//  Admin panel -> /admin      |  Live stats -> /admin/stats
// ==================================================================

const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());

// ---- Settings ----------------------------------------------------
const SECRET    = process.env.SECRET    || 'change-this-secret';   // EA secret
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';             // admin panel password
const PORT      = process.env.PORT      || 3000;
const ACTIVE_WINDOW = 45 * 1000;   // client "active" if polled within 45s

// ---- Memory ------------------------------------------------------
let seq = 0;
const trades  = [];            // recent trades
const MAX_KEEP = 2000;
const masters = {};            // id -> { id, slots, created }
const clients = {};            // "masterId::account" -> { account, master_id, lastSeen }

function ensureMaster(id){
  if(id && !masters[id]) masters[id] = { id, slots: 50, created: Date.now() };
}

// ---- Master EA sends a trade -------------------------------------
app.post('/trade', (req, res) => {
  const d = req.body || {};
  if (d.secret !== SECRET) { console.log('REJECTED bad secret', d.master_id); return res.status(401).json({ ok:false }); }

  ensureMaster(d.master_id);
  seq++;
  const t = { id:seq, master_id:d.master_id, symbol:d.symbol, action:d.action, entry:d.entry, volume:d.volume, price:d.price, time:Date.now() };
  trades.push(t);
  if (trades.length > MAX_KEEP) trades.shift();

  console.log(`[${t.id}] ${t.master_id}  ${t.action} ${t.entry}  ${t.symbol}  ${t.volume}`);
  // How many client accounts are currently connected to this master
  const nowT = Date.now();
  const connected = Object.values(clients).filter(
    c => c.master_id === d.master_id && (nowT - c.lastSeen) < ACTIVE_WINDOW
  ).length;

  res.json({ ok:true, id:t.id, clients: connected });
});

// ---- Client EA polls (now also reports its account) --------------
app.get('/poll', (req, res) => {
  const { master_id, secret, since, account } = req.query;
  if (secret !== SECRET) return res.status(401).type('text/plain').send('');

  ensureMaster(master_id);
  if (account) {
    clients[master_id + '::' + account] = { account, master_id, lastSeen: Date.now() };
  }

  const sinceId = parseInt(since || '0', 10) || 0;
  const lines = trades
    .filter(t => t.master_id === master_id && t.id > sinceId)
    .map(t => `${t.id};${t.symbol};${t.action};${t.entry};${t.volume}`);
  res.type('text/plain').send(lines.join('\n'));
});

// ---- Admin auth --------------------------------------------------
function isAdmin(req){
  const key = req.query.key || req.headers['x-admin-key'] || (req.body && req.body.key);
  return key === ADMIN_KEY;
}

// ---- Admin: live stats -------------------------------------------
app.get('/admin/stats', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:'bad key' });
  const now = Date.now();

  const masterList = Object.values(masters).map(m => {
    const cs = Object.values(clients).filter(c => c.master_id === m.id);
    const list = cs.map(c => ({ account: c.account, active: (now - c.lastSeen) < ACTIVE_WINDOW }));
    return {
      id: m.id,
      slots: m.slots,
      users: cs.length,
      active: list.filter(c => c.active).length,
      clients: list.sort((a,b)=> (b.active?1:0)-(a.active?1:0))
    };
  });

  const totalUsers  = Object.keys(clients).length;
  const totalActive = Object.values(clients).filter(c => (now - c.lastSeen) < ACTIVE_WINDOW).length;

  // Last 15 trades for the live feed
  const recentTrades = trades.slice(-15).reverse().map(t => ({
    id: t.id, master_id: t.master_id, symbol: t.symbol,
    action: t.action, entry: t.entry, volume: t.volume, time: t.time
  }));

  res.json({
    ok:true,
    totalMasters: masterList.length,
    totalUsers,
    totalActive,
    totalTrades: seq,
    recentTrades,
    masters: masterList
  });
});

// ---- Admin: add / update a master (set slots) --------------------
app.post('/admin/master', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:'bad key' });
  const { id, slots } = req.body || {};
  if (!id) return res.json({ ok:false, error:'id required' });
  ensureMaster(id);
  if (slots !== undefined) masters[id].slots = parseInt(slots) || masters[id].slots;
  res.json({ ok:true, master: masters[id] });
});

// ---- Admin: remove a master --------------------------------------
app.post('/admin/master/delete', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:'bad key' });
  const { id } = req.body || {};
  if (id && masters[id]) {
    delete masters[id];
    Object.keys(clients).forEach(k => { if (clients[k].master_id === id) delete clients[k]; });
  }
  res.json({ ok:true });
});

// ---- Pages -------------------------------------------------------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (req, res) => res.send('Copier Bridge server is running'));

// ---- Start -------------------------------------------------------
app.listen(PORT, () => {
  console.log('==================================================');
  console.log('  COPIER BRIDGE SERVER STARTED');
  console.log('  URL   : http://127.0.0.1:' + PORT);
  console.log('  Admin : /admin   (key = ' + ADMIN_KEY + ')');
  console.log('==================================================');
});
