// ==================================================================
//  COPIER BRIDGE  -  Server (Step 1 + Master-ID routing)
//  Master EA  -> POST /trade  (trade yahan aata hai, store hota hai)
//  Slave  EA  -> GET  /poll   (apne master ke naye trade uthata hai)
// ==================================================================

const express = require('express');
const app = express();
app.use(express.json());

// ---- Settings ----------------------------------------------------
const SECRET = 'change-this-secret';   // EA me bhi yahi rakhna
const PORT   = process.env.PORT || 3000;

// ---- Trades memory (recent) --------------------------------------
let seq = 0;
const trades = [];          // { id, master_id, symbol, action, entry, volume, price }
const MAX_KEEP = 2000;

// ---- Master EA yahan trade bhejta hai ----------------------------
app.post('/trade', (req, res) => {
  const d = req.body || {};
  if (d.secret !== SECRET) {
    console.log('REJECTED (galat secret) from:', d.master_id);
    return res.status(401).json({ ok: false });
  }

  seq++;
  const t = {
    id: seq,
    master_id: d.master_id,
    symbol: d.symbol,
    action: d.action,
    entry:  d.entry,
    volume: d.volume,
    price:  d.price
  };
  trades.push(t);
  if (trades.length > MAX_KEEP) trades.shift();

  console.log(`[${t.id}] ${t.master_id}  ${t.action} ${t.entry}  ${t.symbol}  ${t.volume}  @${t.price}`);
  res.json({ ok: true, id: t.id });
});

// ---- Slave EA yahan naye trade uthata hai ------------------------
//  Response format (easy for MT5): id;symbol;action;entry;volume  (per line)
app.get('/poll', (req, res) => {
  const { master_id, secret, since } = req.query;
  if (secret !== SECRET) return res.status(401).type('text/plain').send('');

  const sinceId = parseInt(since || '0', 10) || 0;
  const lines = trades
    .filter(t => t.master_id === master_id && t.id > sinceId)
    .map(t => `${t.id};${t.symbol};${t.action};${t.entry};${t.volume}`);

  res.type('text/plain').send(lines.join('\n'));
});

// ---- Health check ------------------------------------------------
app.get('/', (req, res) => res.send('Copier Bridge server is running'));

// ---- Start -------------------------------------------------------
app.listen(PORT, () => {
  console.log('==================================================');
  console.log('  COPIER BRIDGE SERVER STARTED');
  console.log('  URL : http://127.0.0.1:' + PORT);
  console.log('==================================================');
});
