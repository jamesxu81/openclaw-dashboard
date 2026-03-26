// adapters/openclaw.js
// OpenClaw-specific adapter — reads cron runs from ~/.openclaw/cron,
// recent changes from git workspaces, and launches agents via openclaw CLI.

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

class OpenClawAdapter {
  constructor(config) {
    this.cfg = config.adapter?.openclaw || {};
    this.cronDir = this.cfg.cronDir || path.join(process.env.HOME, '.openclaw', 'cron');
    this.workspaces = this.cfg.workspaces || [];
    this.binPath = this.cfg.binPath || '/opt/homebrew/bin/openclaw';
    this.agentModels = {};
    (this.cfg.agents || []).forEach(a => { this.agentModels[a.id] = a.model; });
  }

  // --- Cron jobs ---
  async getCronJobs() {
    try {
      const jobsPath = path.join(this.cronDir, 'jobs.json');
      if (!fs.existsSync(jobsPath)) return [];
      const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
      const jobs = Array.isArray(raw) ? raw : (raw.jobs || []);
      return jobs.map(j => ({
        id: j.id, name: j.name, enabled: j.enabled !== false,
        schedule: j.schedule || {}, state: j.state || {}, agentId: j.agentId,
      }));
    } catch (e) { return []; }
  }

  // --- Cron history ---
  async getCronHistory({ limit = 100, since = null } = {}) {
    const jobsPath = path.join(this.cronDir, 'jobs.json');
    const runsDir = path.join(this.cronDir, 'runs');
    if (!fs.existsSync(jobsPath)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
      const jobs = Array.isArray(raw) ? raw : (raw.jobs || []);
      const jobMap = {}, jobNextRun = {};
      jobs.forEach(j => { jobMap[j.id] = j.name || j.id; jobNextRun[j.id] = j.state?.nextRunAtMs || null; });
      const allRuns = [];
      if (fs.existsSync(runsDir)) {
        for (const file of fs.readdirSync(runsDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const jobId = file.replace('.jsonl', '');
          const lines = fs.readFileSync(path.join(runsDir, file), 'utf8').trim().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const r = JSON.parse(line);
              if (r.action === 'finished') {
                allRuns.push({
                  jobId, jobName: jobMap[jobId] || jobId, ts: r.ts, status: r.status,
                  summary: r.summary || '', error: r.error || null, durationMs: r.durationMs || 0,
                  runAtMs: r.runAtMs, nextRunAtMs: jobNextRun[jobId] || null,
                  model: r.model || null, tokens: r.usage ? (r.usage.total_tokens || null) : null
                });
              }
            } catch {}
          }
        }
      }
      allRuns.sort((a, b) => b.ts - a.ts);
      const filtered = since ? allRuns.filter(r => r.ts >= since) : allRuns;
      return filtered.slice(0, limit);
    } catch (e) { return []; }
  }

  // --- Agent runner ---
  async runCard(card, cardId, appendLog, onComplete) {
    const agentType = card.agentType || 'research';
    const agentId = agentType === 'coding' ? 'coding-agent' : 'research-agent';
    const prompt = card.details ? `${card.title}\n\nDetails:\n${card.details}` : card.title;
    appendLog(cardId, `Starting ${agentType} agent via OpenClaw...`);

    const args = ['agent', '--agent', agentId, '--session-id', `kanban-${cardId}`, '--message', prompt, '--json'];
    const proc = spawn(this.binPath, args, {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` }
    });

    proc.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) appendLog(cardId, line.substring(0, 200));
    });
    proc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) appendLog(cardId, '[stderr] ' + line.substring(0, 200));
    });
    proc.on('close', code => onComplete(code === 0));
    proc.on('error', e => {
      appendLog(cardId, `❌ Failed to start agent: ${e.message}`);
      onComplete(false);
    });

    return { ok: true };
  }

  // --- Recent changes ---
  async getRecentChanges() {
    const results = [];
    for (const ws of this.workspaces) {
      try {
        const log = execSync(
          `/usr/bin/git -C "${ws.path}" log --since="24 hours ago" --pretty=format:"%H|||%s|||%ai" --name-only`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        if (!log) continue;
        for (const block of log.split('\n\n')) {
          const lines = block.trim().split('\n');
          if (!lines[0]) continue;
          const [hash, msg, date] = lines[0].split('|||');
          const files = lines.slice(1).filter(Boolean);
          if (!files.length) continue;
          let diffStat = '';
          try {
            diffStat = execSync(`/usr/bin/git -C "${ws.path}" show --stat --format="" ${hash}`, { encoding: 'utf8', timeout: 5000 }).trim().split('\n').pop() || '';
          } catch {}
          results.push({ workspace: ws.name, hash: hash.slice(0, 7), message: msg, date, files, diffStat });
        }
      } catch {}
    }
    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    return results;
  }

  async getFileDiff(changeIdx, filename, allChanges) {
    if (changeIdx < 0 || changeIdx >= allChanges.length) throw new Error('Change not found');
    const change = allChanges[changeIdx];
    const ws = this.workspaces.find(w => w.name === change.workspace);
    if (!ws) throw new Error('Workspace not found');
    return execSync(`/usr/bin/git -C "${ws.path}" show ${change._hash} -- "${filename}"`, { encoding: 'utf8', timeout: 5000 });
  }
}

module.exports = OpenClawAdapter;
