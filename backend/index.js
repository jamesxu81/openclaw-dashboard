// index.js — Mission Control Board backend
// Adapter-driven: set "adapter" in config.json to "openclaw", "rest", or "stub"

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────
const configPath = path.join(__dirname, '..', 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const adapterName = process.env.MC_ADAPTER || config.backend?.adapter || 'stub';
const DATA = path.resolve(config.backend?.dataFile || path.join(__dirname, '..', 'data', 'data.json'));

// ── Load Adapter ──────────────────────────────────────
let Adapter;
try {
  Adapter = require(`./adapters/${adapterName}`);
} catch (e) {
  console.error(`[mission-control] Unknown adapter: "${adapterName}". Falling back to stub.`);
  Adapter = require('./adapters/stub');
}
const adapter = new Adapter(config);
console.log(`[mission-control] Using adapter: ${adapterName}`);

// ── Express ───────────────────────────────────────────
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── Data helpers ──────────────────────────────────────
function load() {
  if (!fs.existsSync(DATA)) return {};
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return {}; }
}
function save(d) {
  const dir = path.dirname(DATA);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(d, null, 2));
}

// ── Kanban helper ─────────────────────────────────────
function findCard(data, cardId) {
  for (const col of (data.kanban?.columns || [])) {
    const card = col.cards.find(c => c.id === cardId);
    if (card) return { card, col };
  }
  return null;
}

function appendLog(cardId, line) {
  const d = load();
  const r = findCard(d, cardId);
  if (!r) return;
  if (!r.card.logs) r.card.logs = [];
  r.card.logs.push(`[${new Date().toISOString()}] ${line}`);
  save(d);
}

// ── Agent runner ──────────────────────────────────────
app.post('/api/kanban/cards/:id/run', (req, res) => {
  const d = load();
  const result = findCard(d, req.params.id);
  if (!result) return res.status(404).json({ ok: false, error: 'Card not found' });
  const { card } = result;
  if (card.agentStatus === 'running') return res.status(400).json({ ok: false, error: 'Agent already running' });

  card.agentStatus = 'running';
  card.logs = [`[${new Date().toISOString()}] Agent queued.`];
  // Move to doing
  const doing = (d.kanban?.columns || []).find(c => c.id === 'doing');
  for (const col of (d.kanban?.columns || [])) {
    const idx = col.cards.findIndex(c => c.id === card.id);
    if (idx !== -1 && col.id !== 'doing') { col.cards.splice(idx, 1); if (doing) doing.cards.push(card); break; }
  }
  save(d);

  setImmediate(async () => {
    await adapter.runCard(card, req.params.id, appendLog, (success) => {
      const d2 = load();
      const r = findCard(d2, req.params.id);
      if (r) {
        r.card.agentStatus = success ? 'done' : 'failed';
        if (!r.card.logs) r.card.logs = [];
        r.card.logs.push(`[${new Date().toISOString()}] ${success ? '✅ Completed. Awaiting review.' : '❌ Failed.'}`);
        save(d2);
      }
    });
  });

  res.json({ ok: true, message: 'Agent started' });
});

app.get('/api/kanban/cards/:id/logs', (req, res) => {
  const d = load();
  for (const col of (d.kanban?.columns || [])) {
    const card = col.cards.find(c => c.id === req.params.id);
    if (card) return res.json(card.logs || []);
  }
  res.status(404).json({ error: 'Card not found' });
});

app.patch('/api/kanban/cards/:id', (req, res) => {
  const d = load();
  for (const col of (d.kanban?.columns || [])) {
    const card = col.cards.find(c => c.id === req.params.id);
    if (card) { Object.assign(card, req.body); save(d); return res.json(card); }
  }
  res.status(404).json({ error: 'Card not found' });
});

// ── Crons ─────────────────────────────────────────────
app.get('/api/crons', (req, res) => res.json(load().crons || []));
app.get('/api/crons/:id/logs', (req, res) => {
  const c = (load().crons || []).find(x => String(x.id) === req.params.id);
  res.json(c ? (c.logs || []) : []);
});
app.post('/api/crons/:id/toggle', (req, res) => {
  const d = load();
  const c = (d.crons || []).find(x => String(x.id) === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  c.enabled = !c.enabled;
  save(d); res.json(c);
});

// ── Cron Jobs (adapter-driven) ────────────────────────
app.get('/api/cron/jobs', async (req, res) => {
  try { res.json(await adapter.getCronJobs()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cron-history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const since = req.query.since ? parseInt(req.query.since) : null;
    res.json(await adapter.getCronHistory({ limit, since }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cron/jobs/runs', (req, res) => {
  res.redirect('/api/cron-history?' + new URLSearchParams(req.query).toString());
});

// ── Agents ────────────────────────────────────────────
app.get('/api/agents', (req, res) => res.json(load().agents || []));
app.patch('/api/agents/:id', (req, res) => {
  const d = load();
  const agent = (d.agents || []).find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'not found' });
  Object.assign(agent, req.body);
  save(d); res.json(agent);
});
app.get('/api/agents/:id/logs', (req, res) => {
  const a = (load().agents || []).find(x => String(x.id) === req.params.id);
  res.json(a ? (a.logs || []) : []);
});
app.get('/api/agents/:id/tasks', (req, res) => {
  const d = load();
  const agentId = req.params.id;
  const tasks = [];
  for (const col of (d.kanban?.columns || [])) {
    for (const card of (col.cards || [])) {
      if (card.agentStatus && (card.agentType === agentId || card.agentType === agentId.replace('-agent', ''))) {
        tasks.push({
          id: card.id, title: card.title, desc: card.desc || card.details || '',
          status: card.agentStatus, column: col.id, completedAt: card.completedAt || null,
          logsCount: Array.isArray(card.logs) ? card.logs.length : (card.logs ? 1 : 0),
          lastLog: (card.logs || []).slice(-1)[0] || null
        });
      }
    }
  }
  res.json(tasks);
});

// ── Kanban ────────────────────────────────────────────
app.get('/api/kanban', (req, res) => res.json(load().kanban || { columns: [] }));
app.post('/api/kanban/cards', (req, res) => {
  const d = load();
  const { columnId, card, title, desc, agentType, details } = req.body;
  const cardObj = card || { title, desc, agentType, details };
  const col = (d.kanban?.columns || []).find(c => c.id === columnId);
  if (!col) return res.status(404).json({ error: 'column not found' });
  cardObj.id = cardObj.id || `card-${Date.now()}`;
  col.cards.push(cardObj);
  save(d); res.json(cardObj);
});
app.put('/api/kanban/move', (req, res) => {
  const d = load();
  const { fromColumn, toColumn, cardId } = req.body;
  const from = (d.kanban?.columns || []).find(c => c.id === fromColumn);
  const to = (d.kanban?.columns || []).find(c => c.id === toColumn);
  if (!from || !to) return res.status(404).json({ error: 'column not found' });
  const idx = from.cards.findIndex(x => x.id === cardId);
  if (idx === -1) return res.status(404).json({ error: 'card not found' });
  const card = from.cards.splice(idx, 1)[0];
  if (toColumn === 'done') card.completedAt = new Date().toISOString();
  to.cards.push(card);
  save(d); res.json({ ok: true });
});
app.delete('/api/kanban/cards/:id', (req, res) => {
  const d = load();
  (d.kanban?.columns || []).forEach(col => { col.cards = col.cards.filter(c => c.id !== req.params.id); });
  save(d); res.json({ ok: true });
});

// ── Memories ──────────────────────────────────────────
app.get('/api/memories', (req, res) => res.json(load().memories || []));

// ── Recent Changes (adapter-driven) ───────────────────
let _cachedChanges = [];
app.get('/api/recent-changes', async (req, res) => {
  try {
    _cachedChanges = await adapter.getRecentChanges();
    res.json(_cachedChanges);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recent-changes/:changeIdx/diff', async (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'Missing file parameter' });
  try {
    // Ensure cache is populated
    if (_cachedChanges.length === 0) {
      _cachedChanges = await adapter.getRecentChanges();
    }
    const diff = await adapter.getFileDiff(parseInt(req.params.changeIdx), file, _cachedChanges);
    res.json({ file, diff: diff || 'No diff available' });
  } catch (e) {
    console.error('[diff error]', e.message);
    res.json({ file, diff: `Error: ${e.message}` });
  }
});

// ── Docs ──────────────────────────────────────────────
app.get('/api/docs', (req, res) => res.json(load().docs || []));

// ── Digest ────────────────────────────────────────────
app.get('/api/digest', (req, res) => {
  const d = load();
  const tz = config.app?.timezone || 'UTC';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const crons = (d.crons || []).map(c => ({ name: c.name, status: c.status, schedule: c.schedule }));
  res.json({ date: today, crons, agents: d.agents || [], memories: (d.memories || []).slice(0, 5) });
});

// ── Settings ──────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(load().settings || []));
app.post('/api/settings', (req, res) => {
  const d = load();
  d.settings = req.body;
  save(d); res.json({ ok: true });
});
app.patch('/api/settings/:tool', (req, res) => {
  const d = load();
  const s = (d.settings || []).find(x => x.tool === req.params.tool);
  if (!s) return res.status(404).json({ error: 'not found' });
  Object.assign(s, req.body);
  save(d); res.json(s);
});

// ── Office ────────────────────────────────────────────
app.get('/api/office', (req, res) => res.json(load().office || { grid: [] }));

// ── Full data ──────────────────────────────────────────
app.get('/api/data', (req, res) => res.json(load()));

// ── Config endpoint (frontend can fetch API base, title, etc.) ──
app.get('/api/config', (req, res) => {
  res.json({ title: config.app?.name || 'Mission Control', adapter: adapterName });
});

// ── Config full API ───────────────────────────────────
app.get('/api/config/full', (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/config/full', (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const patch = req.body;
    function deepMerge(target, source) {
      for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          if (!target[key]) target[key] = {};
          deepMerge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
      return target;
    }
    deepMerge(cfg, patch);
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    res.json({ ok: true, config: cfg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || config.backend?.port || 3001;
app.listen(PORT, () => console.log(`[mission-control] Backend → http://localhost:${PORT} (adapter: ${adapterName})`));
