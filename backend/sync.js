// sync.js — Seeds Mission Control data.json on first run.
// For OpenClaw deployments, also syncs memories from workspace.
// For standalone/stub deployments, just seeds default structure.

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const DATA = path.resolve(config.backend?.dataFile || path.join(__dirname, '..', 'data', 'data.json'));

const adapterName = process.env.MC_ADAPTER || config.backend?.adapter || 'stub';
const isOpenClaw = adapterName === 'openclaw';
const workspaceRoot = config.adapter?.openclaw?.workspaceRoot;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function loadData() {
  if (!fs.existsSync(DATA)) return {};
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return {}; }
}

function saveData(d) {
  const dir = path.dirname(DATA);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(d, null, 2));
}

function syncMemories(data) {
  if (!isOpenClaw || !workspaceRoot) return;
  const memDir = path.join(workspaceRoot, 'memory');
  const memMd = path.join(workspaceRoot, 'MEMORY.md');
  const lines = [];
  const memFile = path.join(memDir, `${today()}.md`);
  if (fs.existsSync(memFile)) {
    fs.readFileSync(memFile, 'utf8').split('\n')
      .filter(l => l.trim().startsWith('-'))
      .forEach((l, i) => lines.push({ id: `mem-daily-${i}`, title: l.trim().substring(2, 60), text: l.trim() }));
  }
  if (fs.existsSync(memMd)) {
    const sections = fs.readFileSync(memMd, 'utf8').split('\n##');
    sections.slice(1).forEach((sec, i) => {
      const title = sec.split('\n')[0].trim();
      const text = sec.split('\n').slice(1).join('\n').trim();
      lines.push({ id: `mem-long-${i}`, title: title.substring(0,60), text: text.substring(0,300) });
    });
  }
  if (lines.length) data.memories = lines;
}

function ensureKanban(data) {
  if (!data.kanban) data.kanban = { columns: [] };
  const ids = data.kanban.columns.map(c => c.id);
  if (!ids.includes('todo')) data.kanban.columns.unshift({ id: 'todo', title: 'To Do', cards: [] });
  if (!ids.includes('doing')) {
    const pos = data.kanban.columns.findIndex(c => c.id === 'todo') + 1;
    data.kanban.columns.splice(pos, 0, { id: 'doing', title: 'Doing', cards: [] });
  }
  if (!ids.includes('done')) data.kanban.columns.push({ id: 'done', title: 'Done', cards: [] });
}

function ensureSettings(data) {
  if (!data.settings) {
    data.settings = [
      { tool: 'web_search', enabled: true, permissions: 'read' },
      { tool: 'exec', enabled: true, permissions: 'confirm-destructive' },
      { tool: 'message', enabled: true, permissions: 'draft-first' },
      { tool: 'browser', enabled: true, permissions: 'read' },
      { tool: 'cron', enabled: true, permissions: 'read-write' },
    ];
  }
}

function ensureAgents(data) {
  if (!data.agents) {
    data.agents = [
      { id: 'research-agent', name: 'Elon Musk', role: 'Research Agent', status: 'idle', avatar: 'avatars/iron-man.png', currentTask: null, logs: [] },
      { id: 'coding-agent', name: 'Bill Gates', role: 'Coding Agent', status: 'idle', avatar: 'avatars/hulk.png', currentTask: null, logs: [] },
    ];
  }
}

function run() {
  const data = loadData();
  syncMemories(data);
  ensureKanban(data);
  ensureSettings(data);
  ensureAgents(data);
  if (!data.crons) data.crons = [];
  if (!data.docs) data.docs = [];
  if (!data.office) data.office = { grid: [] };
  saveData(data);
  console.log(`[sync] Mission Control data seeded (adapter: ${adapterName}).`);
}

run();
