// index.js — Mission Control Board backend
// Adapter-driven: set "adapter" in config.json to "openclaw" or "rest"

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Config ────────────────────────────────────────────
const configPath = path.join(__dirname, '..', 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const adapterName = process.env.MC_ADAPTER || config.backend?.adapter || 'openclaw';
const DATA = path.resolve(config.backend?.dataFile || path.join(__dirname, '..', 'data', 'data.json'));

// ── Load Adapter ──────────────────────────────────────
let Adapter;
try {
  Adapter = require(`./adapters/${adapterName}`);
} catch (e) {
  console.error(`[mission-control] Failed to load adapter "${adapterName}": ${e.stack || e.message}`);
  process.exit(1);
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

// ── Startup: reconcile any cards stuck in doing/running ──────────────────
// If the backend restarted while an agent run was in progress, in-memory proc
// references are lost and proc.on('close') never fires. On startup we detect
// these stuck cards and reset them to todo so they can be re-run.
function reconcileStuckCards() {
  try {
    const d = load();
    const doing = (d.kanban?.columns || []).find(c => c.id === 'doing');
    const todo = (d.kanban?.columns || []).find(c => c.id === 'todo');
    if (!doing || !todo) return;

    const stuckCards = doing.cards.filter(c => c.agentStatus === 'running');
    if (!stuckCards.length) return;

    console.log(`[mission-control] Startup reconciliation: found ${stuckCards.length} stuck card(s) in doing/running`);
    for (const card of stuckCards) {
      console.log(`[mission-control] Reconciling stuck card: ${card.id} — "${card.title}"`);
      card.agentStatus = 'todo';
      if (!card.logs) card.logs = [];
      card.logs.push(`[${new Date().toISOString()}] ⚠️ Reconciled on startup: backend restarted while agent was running. Card reset to todo for re-run.`);
      // Move card back to todo
      doing.cards = doing.cards.filter(c => c.id !== card.id);
      todo.cards.push(card);
    }

    // Also reset any agent statuses that were left as 'running'
    for (const agent of (d.agents || [])) {
      if (agent.status === 'running') {
        console.log(`[mission-control] Startup reconciliation: resetting agent ${agent.id} status running → idle`);
        agent.status = 'idle';
        agent.currentTask = null;
      }
    }

    save(d);
    console.log(`[mission-control] Startup reconciliation complete.`);
  } catch (e) {
    console.error(`[mission-control] Startup reconciliation error: ${e.message}`);
  }
}

// Run reconciliation after a short delay so the server is ready first
setTimeout(reconcileStuckCards, 2000);

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

// ── Kanban completed feed ─────────────────────────────
// Returns cards that completed (success or failure) since a given timestamp.
// The main orchestrator polls this to know when to notify James.
// Usage: GET /api/kanban/completed?since=<epochMs>
// Returns: [ { id, title, success, completedAt, completionSummary, agentStatus } ]
app.get('/api/kanban/completed', (req, res) => {
  const since = req.query.since ? parseInt(req.query.since, 10) : 0;
  const d = load();
  const results = [];
  for (const col of (d.kanban?.columns || [])) {
    for (const card of (col.cards || [])) {
      // A card is a completed event if it has completedAt and it's after `since`
      if (card.completedAt) {
        const ts = new Date(card.completedAt).getTime();
        if (ts > since) {
          results.push({
            id: card.id,
            title: card.title || '(untitled)',
            column: col.id,
            agentStatus: card.agentStatus || null,
            completionSuccess: card.completionSuccess ?? (card.agentStatus === 'done'),
            completedAt: card.completedAt,
            completionSummary: card.completionSummary || null,
            agentId: card.agentType || null,
          });
        }
      }
    }
  }
  // Newest first
  results.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  res.json(results);
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

// ── Default Agent ─────────────────────────────────────
app.get('/api/default-agent', (req, res) => {
  try {
    const ocPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(ocPath)) return res.json({ id: null, model: null, workspace: null, thinkingDefault: null });
    const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
    const defaults = oc.agents?.defaults || {};
    res.json({
      id: 'main',
      model: (typeof defaults.model === 'object' ? defaults.model?.primary : defaults.model) || null,
      workspace: defaults.workspace || null,
      thinkingDefault: defaults.thinkingDefault || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/default-agent', (req, res) => {
  try {
    const ocPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
    const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
    if (!oc.agents) oc.agents = {};
    if (!oc.agents.defaults) oc.agents.defaults = {};
    const { model, workspace, thinkingDefault } = req.body;
    if (model !== undefined) {
      if (!oc.agents.defaults.model || typeof oc.agents.defaults.model === 'string') {
        oc.agents.defaults.model = { primary: model, fallbacks: [] };
      } else {
        oc.agents.defaults.model.primary = model;
      }
    }
    if (workspace !== undefined) oc.agents.defaults.workspace = workspace;
    if (thinkingDefault !== undefined) oc.agents.defaults.thinkingDefault = thinkingDefault || undefined;
    // Back up and save
    fs.writeFileSync(ocPath + '.bak', fs.readFileSync(ocPath));
    fs.writeFileSync(ocPath, JSON.stringify(oc, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agents ────────────────────────────────────────────
app.get('/api/agents', (req, res) => {
  // Merge live agents from openclaw.json with status from data.json
  const d = load();
  const statusMap = {};
  (d.agents || []).forEach(a => { statusMap[a.id] = a; });
  // Read live agent list from openclaw.json
  let liveAgents = [];
  const ocPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
  if (fs.existsSync(ocPath)) {
    try {
      const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
      const defaults = oc.agents?.defaults || {};
      // Prepend main/default agent as first entry
      const mainEntry = {
        id: 'main',
        name: statusMap['main']?.name || 'Main Agent',
        role: 'Team Lead',
        status: statusMap['main']?.status || 'idle',
        avatar: statusMap['main']?.avatar || 'avatars/iron-man.png',
        currentTask: statusMap['main']?.currentTask || null,
        logs: statusMap['main']?.logs || [],
        model: (typeof defaults.model === 'object' ? defaults.model?.primary : defaults.model) || '',
        workspace: defaults.workspace || '',
        thinkingDefault: defaults.thinkingDefault || '',
        isDefault: true
      };
      liveAgents = [mainEntry, ...(oc.agents?.list || []).filter(a => a.id !== 'main').map(a => ({
        id: a.id,
        name: statusMap[a.id]?.name || a.id.replace(/-agent$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' Agent',
        role: statusMap[a.id]?.role || a.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        status: statusMap[a.id]?.status || 'idle',
        avatar: statusMap[a.id]?.avatar || 'avatars/iron-man.png',
        currentTask: statusMap[a.id]?.currentTask || null,
        logs: statusMap[a.id]?.logs || [],
        model: (typeof a.model === 'object' ? a.model?.primary : a.model) || '',
        workspace: a.workspace || '',
        thinkingDefault: a.thinkingDefault || '',
        isDefault: false
      }))];
    } catch {}
  }
  // Fall back to data.json if openclaw.json not available
  if (!liveAgents.length) liveAgents = d.agents || [];
  // Sync back to data.json so status updates work
  d.agents = liveAgents;
  save(d);
  res.json(liveAgents);
});
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
app.put('/api/kanban/reorder', (req, res) => {
  const d = load();
  const { columnId, cardIds } = req.body;
  const col = (d.kanban?.columns || []).find(c => c.id === columnId);
  if (!col) return res.status(404).json({ error: 'column not found' });
  // Reorder cards according to cardIds array
  const cardMap = {};
  col.cards.forEach(c => cardMap[c.id] = c);
  const reordered = cardIds.map(id => cardMap[id]).filter(Boolean);
  // Keep any cards not in cardIds at the end
  const remaining = col.cards.filter(c => !cardIds.includes(c.id));
  col.cards = [...reordered, ...remaining];
  save(d); res.json({ ok: true });
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

// ── Models list (from openclaw CLI) ──────────────────────────────────────
app.get('/api/models', (req, res) => {
  try {
    const binPath = config.adapter?.openclaw?.binPath || '/opt/homebrew/bin/openclaw';
    console.log('[/api/models] Fetching models list...');
    const out = execSync(`${binPath} models list --all --json 2>/dev/null`, { 
      encoding: 'utf8', 
      timeout: 15000,  // Increased to 15s
      shell: '/bin/bash',
      maxBuffer: 10 * 1024 * 1024  // 10MB buffer for large model lists
    });
    // Strip any non-JSON lines before the first '{'
    const jsonStart = out.indexOf('{');
    const clean = jsonStart >= 0 ? out.slice(jsonStart) : out;
    const data = JSON.parse(clean);
    const models = Array.isArray(data.models) ? data.models : [];
    console.log(`[/api/models] Successfully fetched ${models.length} models`);
    res.json(models);
  } catch (e) {
    console.error('[/api/models] Error fetching models:', e.message);
    console.error('[/api/models] Attempting fallback to configured models only...');
    // Fallback: try without --all flag
    try {
      const binPath = config.adapter?.openclaw?.binPath || '/opt/homebrew/bin/openclaw';
      const out = execSync(`${binPath} models list --json 2>/dev/null`, { 
        encoding: 'utf8', 
        timeout: 5000,
        shell: '/bin/bash'
      });
      const jsonStart = out.indexOf('{');
      const clean = jsonStart >= 0 ? out.slice(jsonStart) : out;
      const data = JSON.parse(clean);
      const models = Array.isArray(data.models) ? data.models : [];
      console.log(`[/api/models] Fallback succeeded with ${models.length} configured models`);
      res.json(models);
    } catch (fallbackError) {
      console.error('[/api/models] Fallback also failed:', fallbackError.message);
      // Settings should still load even if model discovery fails completely.
      res.json([]);
    }
  }
});

// ── Workspaces list (for dropdown population) ─────────────────────────────
app.get('/api/workspaces', (req, res) => {
  try {
    const ocConfigPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
    const workspaceRoot = config.adapter?.openclaw?.workspaceRoot || path.join(process.env.HOME, '.openclaw');
    const results = [];

    // 1. Scan workspaceRoot directory for workspace-* folders
    if (fs.existsSync(workspaceRoot)) {
      const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('workspace')) {
          const fullPath = path.join(workspaceRoot, entry.name);
          results.push({ name: entry.name, path: fullPath });
        }
      }
    }

    // 2. Augment with workspaces from openclaw.json agents list (in case any are outside workspaceRoot)
    if (fs.existsSync(ocConfigPath)) {
      try {
        const oc = JSON.parse(fs.readFileSync(ocConfigPath, 'utf8'));
        const agentList = oc.agents?.list || [];
        const agentDefaults = oc.agents?.defaults || {};
        const defaultWs = agentDefaults.workspace;
        if (defaultWs && !results.find(r => r.path === defaultWs)) {
          results.push({ name: 'workspace (default)', path: defaultWs });
        }
        for (const a of agentList) {
          if (a.workspace && !results.find(r => r.path === a.workspace)) {
            results.push({ name: a.id + ' workspace', path: a.workspace });
          }
        }
      } catch (e) { /* ignore parse errors */ }
    }

    // Deduplicate and sort
    const seen = new Set();
    const unique = results.filter(r => {
      if (seen.has(r.path)) return false;
      seen.add(r.path);
      return true;
    }).sort((a, b) => a.name.localeCompare(b.name));

    res.json(unique);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Full data ──────────────────────────────────────────
app.get('/api/data', (req, res) => res.json(load()));

// ── Config endpoint (frontend can fetch API base, title, etc.) ──
app.get('/api/config', (req, res) => {
  // Re-read config.json to get latest (including ownerName set via Settings)
  try {
    const latest = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json({
      title: latest.app?.name || 'Mission Control',
      adapter: adapterName,
      timezone: latest.app?.timezone || 'UTC',
      ownerName: latest.app?.ownerName || ''
    });
  } catch {
    res.json({ title: config.app?.name || 'Mission Control', adapter: adapterName, timezone: config.app?.timezone || 'UTC' });
  }
});

// ── Config full API ───────────────────────────────────
app.get('/api/config/full', (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Read real agents and workspaces from OpenClaw config
    const ocConfigPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(ocConfigPath)) {
      try {
        const oc = JSON.parse(fs.readFileSync(ocConfigPath, 'utf8'));
        const agentDefaults = oc.agents?.defaults || {};
        const agentList = (oc.agents?.list || []).filter(a => a.id !== 'main');
        // Build agents array with real workspace paths
        if (!cfg.adapter) cfg.adapter = {};
        if (!cfg.adapter.openclaw) cfg.adapter.openclaw = {};
        cfg.adapter.openclaw.agents = agentList.map(a => ({
          id: a.id,
          model: (typeof a.model === 'object' ? a.model?.primary : a.model) || agentDefaults.model?.primary || '',
          workspace: a.workspace || agentDefaults.workspace || '',
          thinkingDefault: a.thinkingDefault || agentDefaults.thinkingDefault || ''
        }));
        // Build workspaces from agents (use the mapped list which has workspace)
        cfg.adapter.openclaw.workspaces = agentList
          .filter(a => a.workspace)
          .map(a => ({ name: a.id, path: a.workspace }));
      } catch (e) { console.error('[config/full] OpenClaw config read error:', e.message); }
    }
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Agent Name & Avatar (writes to data.json) ─────────────────────────────
const avatarsDir = path.join(__dirname, '..', 'frontend', 'avatars');

// POST /api/agents/:id/avatar — upload avatar as base64
app.post('/api/agents/:id/avatar', (req, res) => {
  try {
    const { base64, ext } = req.body; // ext: 'png' | 'jpg' etc
    if (!base64) return res.status(400).json({ error: 'base64 required' });
    const filename = `${req.params.id}.${ext || 'png'}`;
    const filepath = path.join(avatarsDir, filename);
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
    // Update data.json
    const d = load();
    const agent = (d.agents || []).find(a => a.id === req.params.id);
    if (agent) { agent.avatar = `avatars/${filename}`; save(d); }
    res.json({ ok: true, avatar: `avatars/${filename}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/agents/:id/meta — update name/role in data.json
app.patch('/api/agents/:id/meta', (req, res) => {
  try {
    const d = load();
    let agent = (d.agents || []).find(a => a.id === req.params.id);
    if (!agent) {
      // Create entry if not exists
      if (!d.agents) d.agents = [];
      agent = { id: req.params.id, status: 'idle', currentTask: null, logs: [] };
      d.agents.push(agent);
    }
    const { name, role, avatar } = req.body;
    if (name !== undefined) agent.name = name;
    if (role !== undefined) agent.role = role;
    if (avatar !== undefined) agent.avatar = avatar;
    save(d); res.json({ ok: true, agent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── OpenClaw Agent CRUD (writes to ~/.openclaw/openclaw.json) ──────────────
const ocConfigPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');

function loadOCConfig() {
  return JSON.parse(fs.readFileSync(ocConfigPath, 'utf8'));
}
function saveOCConfig(oc) {
  // Back up first
  fs.writeFileSync(ocConfigPath + '.bak', fs.readFileSync(ocConfigPath));
  fs.writeFileSync(ocConfigPath, JSON.stringify(oc, null, 2));
}

// POST /api/oc/agents — add new agent
app.post('/api/oc/agents', (req, res) => {
  try {
    const { id, model, workspace, thinkingDefault } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const oc = loadOCConfig();
    if (!oc.agents) oc.agents = { defaults: {}, list: [] };
    if (!oc.agents.list) oc.agents.list = [];
    if (oc.agents.list.find(a => a.id === id)) return res.status(409).json({ error: `Agent "${id}" already exists` });
    const entry = { id };
    if (model) entry.model = { primary: model, fallbacks: [] };
    if (workspace) entry.workspace = workspace;
    if (thinkingDefault) entry.thinkingDefault = thinkingDefault;
    oc.agents.list.push(entry);
    saveOCConfig(oc);

    // Auto-init git repo in workspace if it has no commits yet
    if (workspace) {
      // Auto-create directory if it doesn't exist yet
      if (!fs.existsSync(workspace)) {
        fs.mkdirSync(workspace, { recursive: true });
        console.log(`[oc/agents] Created workspace directory: ${workspace}`);
      }
      const { execSync: execS } = require('child_process');
      try {
        execS(`/usr/bin/git -C "${workspace}" rev-parse HEAD`, { encoding: 'utf8', stdio: 'pipe' });
        // Already has commits — skip
      } catch {
        try {
          // No commits yet — init git and make initial commit
          execS(`/usr/bin/git -C "${workspace}" init`, { encoding: 'utf8' });
          execS(`/usr/bin/git -C "${workspace}" config user.email "agent@openclaw"`, { encoding: 'utf8' });
          execS(`/usr/bin/git -C "${workspace}" config user.name "${id}"`, { encoding: 'utf8' });
          execS(`/usr/bin/git -C "${workspace}" add -A`, { encoding: 'utf8' });
          execS(`/usr/bin/git -C "${workspace}" commit -m "init: workspace initialized for ${id}"`, { encoding: 'utf8' });
          console.log(`[oc/agents] Auto-initialized git repo for ${id} at ${workspace}`);
        } catch(gitErr) {
          console.warn(`[oc/agents] Git init skipped for ${id}: ${gitErr.message}`);
        }
      }
    }

    res.json({ ok: true, agent: entry });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/oc/agents/:id — update agent
app.patch('/api/oc/agents/:id', (req, res) => {
  try {
    const oc = loadOCConfig();
    const idx = (oc.agents?.list || []).findIndex(a => a.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Agent not found' });
    const agent = oc.agents.list[idx];
    const { id, model, workspace, thinkingDefault } = req.body;
    if (id && id !== agent.id) agent.id = id;
    if (model !== undefined) agent.model = { primary: model, fallbacks: agent.model?.fallbacks || [] };
    if (workspace !== undefined) agent.workspace = workspace;
    if (thinkingDefault !== undefined) agent.thinkingDefault = thinkingDefault || undefined;
    saveOCConfig(oc);

    // Auto-init git repo if workspace was set and has no commits
    const wsPath = workspace || agent.workspace;
    if (wsPath) {
      // Auto-create directory if it doesn't exist yet
      if (!fs.existsSync(wsPath)) {
        fs.mkdirSync(wsPath, { recursive: true });
        console.log(`[oc/agents] Created workspace directory: ${wsPath}`);
      }
      const { execSync: execS } = require('child_process');
      try {
        execS(`/usr/bin/git -C "${wsPath}" rev-parse HEAD`, { encoding: 'utf8', stdio: 'pipe' });
      } catch {
        try {
          const agentName = id || req.params.id;
          execS(`/usr/bin/git -C "${wsPath}" init`, { encoding: 'utf8' });
          execS(`/usr/bin/git -C "${wsPath}" config user.email "agent@openclaw"`, { encoding: 'utf8' });
          execS(`/usr/bin/git -C "${wsPath}" config user.name "${agentName}"`, { encoding: 'utf8' });
          execS(`/usr/bin/git -C "${wsPath}" add -A`, { encoding: 'utf8' });
          execS(`/usr/bin/git -C "${wsPath}" commit -m "init: workspace initialized for ${agentName}"`, { encoding: 'utf8' });
          console.log(`[oc/agents] Auto-initialized git repo at ${wsPath}`);
        } catch(gitErr) {
          console.warn(`[oc/agents] Git init skipped: ${gitErr.message}`);
        }
      }
    }

    res.json({ ok: true, agent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/oc/agents/:id — remove agent
app.delete('/api/oc/agents/:id', (req, res) => {
  try {
    const oc = loadOCConfig();
    const before = (oc.agents?.list || []).length;
    oc.agents.list = (oc.agents.list || []).filter(a => a.id !== req.params.id);
    if (oc.agents.list.length === before) return res.status(404).json({ error: 'Agent not found' });
    saveOCConfig(oc);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// ── Workspace Files ───────────────────────────────────
// Shared helper: get workspaceRoot and validate wsName
function _wsRoot() {
  return config.adapter?.openclaw?.workspaceRoot || path.join(process.env.HOME, '.openclaw');
}
function _validateWs(wsName) {
  if (!wsName || !wsName.startsWith('workspace')) return null;
  const wsRoot = _wsRoot();
  const wsPath = path.join(wsRoot, wsName);
  const resolved = path.resolve(wsPath);
  if (!resolved.startsWith(path.resolve(wsRoot) + path.sep) && resolved !== path.resolve(wsRoot)) return null;
  return resolved;
}
// List all workspaces with their top-level files (files only, no dirs)
const SKIP_FILES = new Set(['.DS_Store', '.gitkeep', 'Thumbs.db']);
function listWsFiles(wsPath) {
  try {
    return fs.readdirSync(wsPath, { withFileTypes: true })
      .filter(e => e.isFile() && !SKIP_FILES.has(e.name))
      .map(e => e.name)
      .sort();
  } catch { return []; }
}
app.get('/api/workspace-files', (req, res) => {
  try {
    const wsRoot = _wsRoot();
    const results = [];
    if (fs.existsSync(wsRoot)) {
      for (const entry of fs.readdirSync(wsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('workspace')) {
          const wsPath = path.join(wsRoot, entry.name);
          results.push({ name: entry.name, path: wsPath, files: listWsFiles(wsPath) });
        }
      }
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List files for a single workspace
app.get('/api/workspace-files/:wsName', (req, res) => {
  try {
    const wsPath = _validateWs(req.params.wsName);
    if (!wsPath) return res.status(400).json({ error: 'Invalid workspace name' });
    if (!fs.existsSync(wsPath)) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ name: req.params.wsName, path: wsPath, files: listWsFiles(wsPath) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Read a specific file from a workspace — ?file=filename (filename only, no path traversal)
app.get('/api/workspace-files/:wsName/read', (req, res) => {
  try {
    const wsPath = _validateWs(req.params.wsName);
    if (!wsPath) return res.status(400).json({ error: 'Invalid workspace name' });
    const fileName = req.query.file;
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.startsWith('.')) {
      return res.status(400).json({ error: 'Invalid file name' });
    }
    if (SKIP_FILES.has(fileName)) return res.status(400).json({ error: 'File not accessible' });
    const filePath = path.join(wsPath, fileName);
    // Final safety: must be directly inside wsPath
    if (path.dirname(path.resolve(filePath)) !== wsPath) return res.status(403).json({ error: 'Forbidden' });
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }
    // Size limit: don't serve files over 512KB
    const stat = fs.statSync(filePath);
    if (stat.size > 512 * 1024) return res.status(413).json({ error: 'File too large (>512KB)' });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ name: fileName, workspace: req.params.wsName, content, size: stat.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Workspace Tree/File API ──────────────────────────────────────────────────
const SKIP_TREE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.DS_Store', '.cache']);
const SKIP_TREE_FILES = new Set(['.DS_Store', '.gitkeep', 'Thumbs.db']);
const WS_MAX_DEPTH = 5;
const WS_MAX_FILE_SIZE = 512 * 1024;

function buildDirTree(dirPath, depth) {
  if (depth > WS_MAX_DEPTH) return [];
  let items;
  try { items = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return []; }
  const dirs = [], files = [];
  for (const item of items) {
    if (SKIP_TREE_DIRS.has(item.name)) continue;
    if (item.isDirectory()) dirs.push(item.name);
    else if (item.isFile() && !SKIP_TREE_FILES.has(item.name)) files.push(item.name);
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  const result = [];
  for (const name of dirs) {
    const children = buildDirTree(path.join(dirPath, name), depth + 1);
    result.push({ type: 'dir', name, children });
  }
  for (const name of files) {
    result.push({ type: 'file', name });
  }
  return result;
}

// GET /api/workspace/tree?ws=<wsName> — returns full folder tree
app.get('/api/workspace/tree', (req, res) => {
  try {
    const wsPath = _validateWs(req.query.ws);
    if (!wsPath) return res.status(400).json({ error: 'Invalid workspace name' });
    if (!fs.existsSync(wsPath)) return res.status(404).json({ error: 'Workspace not found' });
    const tree = buildDirTree(wsPath, 0);
    res.json({ workspace: req.query.ws, children: tree });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/workspace/file?ws=<wsName>&path=<relPath> — read file with subdirectory support
app.get('/api/workspace/file', (req, res) => {
  try {
    const wsPath = _validateWs(req.query.ws);
    if (!wsPath) return res.status(400).json({ error: 'Invalid workspace name' });
    if (!req.query.path) return res.status(400).json({ error: 'Missing path parameter' });
    const filePath = path.resolve(wsPath, req.query.path);
    // Path traversal protection
    if (!filePath.startsWith(wsPath + path.sep)) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).json({ error: 'File not found' });
    const stat = fs.statSync(filePath);
    if (stat.size > WS_MAX_FILE_SIZE) return res.status(413).json({ error: 'File too large (>512KB)' });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ path: req.query.path, workspace: req.query.ws, content, size: stat.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/workspace/file — save file content
app.post('/api/workspace/file', (req, res) => {
  try {
    const { ws, path: relPath, content } = req.body;
    if (!ws || !relPath || content === undefined) return res.status(400).json({ error: 'Missing ws, path, or content' });
    const wsPath = _validateWs(ws);
    if (!wsPath) return res.status(400).json({ error: 'Invalid workspace name' });
    const filePath = path.resolve(wsPath, relPath);
    // Path traversal protection
    if (!filePath.startsWith(wsPath + path.sep)) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).json({ error: 'File not found' });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true, path: relPath, workspace: ws });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || config.backend?.port || 3001;
app.listen(PORT, () => console.log(`[mission-control] Backend → http://localhost:${PORT} (adapter: ${adapterName})`));
