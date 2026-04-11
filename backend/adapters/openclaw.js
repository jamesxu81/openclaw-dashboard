// adapters/openclaw.js
// OpenClaw-specific adapter — reads cron runs from ~/.openclaw/cron,
// recent changes from git workspaces, and launches agents via openclaw CLI.

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ── Max wall-clock time for a single agent run (ms) ─────────────────────────
// Matches openclaw CLI default timeout (600s) plus a 30s grace buffer
const AGENT_RUN_TIMEOUT_MS = 630_000;

class OpenClawAdapter {
  constructor(config) {
    this.cfg = config.adapter?.openclaw || {};
    this.cronDir = this.cfg.cronDir || path.join(process.env.HOME, '.openclaw', 'cron');
    this.binPath = this.cfg.binPath || '/opt/homebrew/bin/openclaw';
    this.mcBase = this.cfg.mcBase || 'http://localhost:3002';
    this.agentModels = {};
    (this.cfg.agents || []).forEach(a => { this.agentModels[a.id] = a.model; });
    this._initWorkspaces();
  }

  _initWorkspaces() {
    const home = process.env.HOME;
    const ocPath = path.join(home, '.openclaw', 'openclaw.json');
    const wsSet = new Map();

    wsSet.set('workspace', { name: 'workspace', path: path.join(home, '.openclaw', 'workspace') });

    if (fs.existsSync(ocPath)) {
      try {
        const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
        for (const a of (oc.agents?.list || [])) {
          if (a.workspace) wsSet.set(a.id, { name: a.id, path: a.workspace });
        }
      } catch {}
    }

    for (const ws of (this.cfg.workspaces || [])) {
      if (ws.path) wsSet.set(ws.name, { name: ws.name, path: ws.path });
    }

    this.workspaces = Array.from(wsSet.values());
  }

  async getCronJobs() {
    try {
      const jobsPath = path.join(this.cronDir, 'jobs.json');
      if (!fs.existsSync(jobsPath)) return [];
      const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
      const jobs = Array.isArray(raw) ? raw : (raw.jobs || []);
      return jobs.map(j => ({
        id: j.id,
        name: j.name,
        enabled: j.enabled !== false,
        schedule: j.schedule || {},
        state: j.state || {},
        agentId: j.agentId,
      }));
    } catch {
      return [];
    }
  }

  async getCronHistory({ limit = 100, since = null } = {}) {
    const jobsPath = path.join(this.cronDir, 'jobs.json');
    const runsDir = path.join(this.cronDir, 'runs');
    if (!fs.existsSync(jobsPath)) return [];

    try {
      const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
      const jobs = Array.isArray(raw) ? raw : (raw.jobs || []);
      const jobMap = {};
      const jobNextRun = {};

      jobs.forEach(j => {
        jobMap[j.id] = j.name || j.id;
        jobNextRun[j.id] = j.state?.nextRunAtMs || null;
      });

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
                  jobId,
                  jobName: jobMap[jobId] || jobId,
                  ts: r.ts,
                  status: r.status,
                  summary: r.summary || '',
                  error: r.error || null,
                  durationMs: r.durationMs || 0,
                  runAtMs: r.runAtMs,
                  nextRunAtMs: jobNextRun[jobId] || null,
                  model: r.model || null,
                  tokens: r.usage ? (r.usage.total_tokens || null) : null,
                });
              }
            } catch {}
          }
        }
      }

      allRuns.sort((a, b) => b.ts - a.ts);
      const filtered = since ? allRuns.filter(r => r.ts >= since) : allRuns;
      return filtered.slice(0, limit);
    } catch {
      return [];
    }
  }

  _getWorkspaceForAgent(agentId) {
    this._initWorkspaces();
    if (agentId === 'main') {
      return this.workspaces.find(w => w.name === 'workspace') || null;
    }
    return this.workspaces.find(w => w.name === agentId) || null;
  }

  _getHotPathForAgent(agentId) {
    const ws = this._getWorkspaceForAgent(agentId);
    if (!ws) return null;
    return path.join(ws.path, '.learnings', 'HOT.md');
  }

  _readHotForAgent(agentId) {
    try {
      const hotPath = this._getHotPathForAgent(agentId);
      if (!hotPath || !fs.existsSync(hotPath)) return null;
      const content = fs.readFileSync(hotPath, 'utf8').trim();
      return content || null;
    } catch {
      return null;
    }
  }

  async _fetch(url, opts = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  async _moveCard(cardId, fromColumn, toColumn, appendLog) {
    const url = `${this.mcBase}/api/kanban/move`;
    const body = JSON.stringify({ fromColumn, toColumn, cardId });
    try {
      const res = await this._fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) {
        appendLog(cardId, `📋 Card moved: ${fromColumn} → ${toColumn}`);
        return true;
      }
      const errText = await res.text().catch(() => String(res.status));
      appendLog(cardId, `⚠️ Card move failed (${res.status}): ${errText.substring(0, 200)}`);
      return false;
    } catch (e) {
      appendLog(cardId, `❌ Card move error (${fromColumn}→${toColumn}): ${e.message}`);
      return false;
    }
  }

  async _patchCard(cardId, patch, appendLog) {
    const url = `${this.mcBase}/api/kanban/cards/${cardId}`;
    try {
      const res = await this._fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => String(res.status));
        appendLog(cardId, `⚠️ Card patch failed (${res.status}): ${errText.substring(0, 200)}`);
      }
      return res.ok;
    } catch (e) {
      appendLog(cardId, `❌ Card patch error: ${e.message}`);
      return false;
    }
  }

  async _setAgentStatus(agentId, status, currentTask, appendLog, cardId) {
    try {
      const res = await this._fetch(`${this.mcBase}/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, currentTask }),
      });
      if (res.ok) {
        appendLog(cardId, `🔵 Agent ${agentId} status → ${status}`);
      } else {
        appendLog(cardId, `⚠️ Agent status update failed (${res.status})`);
      }
      return res.ok;
    } catch (e) {
      appendLog(cardId, `⚠️ Agent status update error: ${e.message}`);
      return false;
    }
  }

  async runCard(card, cardId, appendLog, onComplete) {
    const self = this;
    const startMs = Date.now();
    const agentType = card.agentType || 'research';

    const agentId = (() => {
      if (agentType === 'coding') return 'coding-agent';
      if (agentType === 'research') return 'research-agent';
      return agentType;
    })();

    const hotRules = this._readHotForAgent(agentId);
    const prompt = [
      hotRules
        ? `Before doing anything else, read and obey these HOT rules for this agent. Keep them in mind throughout the task.\n\n${hotRules}`
        : null,
      card.details ? `${card.title}\n\nDetails:\n${card.details}` : card.title,
    ].filter(Boolean).join('\n\n---\n\n');

    appendLog(cardId, `🚀 Assigning to agent: ${agentId}`);
    if (hotRules) {
      appendLog(cardId, `🧠 HOT rules injected from ${this._getHotPathForAgent(agentId)}`);
    } else {
      appendLog(cardId, `ℹ️ No HOT.md found for ${agentId}; running without HOT injection`);
    }

    await this._setAgentStatus(agentId, 'running', card.title, appendLog, cardId);

    const sessionId = `kanban-${cardId}`;
    const cliBudgetSecs = Math.floor(AGENT_RUN_TIMEOUT_MS / 1000) - 30;
    const args = [
      'agent',
      '--agent', agentId,
      '--session-id', sessionId,
      '--message', prompt,
      '--json',
      '--timeout', String(cliBudgetSecs),
    ];

    appendLog(cardId, `⚙️ Spawning: openclaw agent --agent ${agentId} --session-id ${sessionId} --timeout ${cliBudgetSecs}`);

    const proc = spawn(this.binPath, args, {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
    });

    let finalized = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    const killTimer = setTimeout(() => {
      if (finalized) return;
      appendLog(cardId, `⏱️ Hard timeout (${AGENT_RUN_TIMEOUT_MS / 1000}s) — killing agent process`);
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      finalize(false, `⏱️ Timed out after ${AGENT_RUN_TIMEOUT_MS / 1000}s`);
    }, AGENT_RUN_TIMEOUT_MS);

    proc.stdout.on('data', chunk => { stdoutBuf += chunk.toString(); });
    proc.stderr.on('data', chunk => {
      const line = chunk.toString().trim();
      if (line && !line.startsWith('Config warnings') && !line.includes('plugin disabled')) {
        stderrBuf += line + '\n';
        appendLog(cardId, '[stderr] ' + line.substring(0, 300));
      }
    });

    proc.on('error', e => {
      appendLog(cardId, `❌ Failed to start agent process: ${e.message}`);
      finalize(false, `❌ Process spawn error: ${e.message}`);
    });

    proc.on('close', code => {
      (async () => {
        let success = code === 0;
        let summary = '';

        if (stdoutBuf.trim()) {
          try {
            const json = JSON.parse(stdoutBuf.trim());
            if (json.status === 'ok') {
              success = true;
              const dur = json.result?.meta?.durationMs;
              summary = dur ? `✅ Done in ${Math.round(dur / 1000)}s` : '✅ Completed';
              for (const p of (json.result?.payloads || [])) {
                if (p.text) appendLog(cardId, `💬 Agent reply: ${p.text.substring(0, 600)}`);
              }
            } else {
              success = false;
              summary = `❌ Agent status: ${json.status}${json.error ? ` — ${json.error}` : ''}`;
            }
            appendLog(cardId, summary);
          } catch {
            for (const line of stdoutBuf.trim().split('\n').slice(0, 20)) {
              if (line.trim()) appendLog(cardId, line.substring(0, 300));
            }
            summary = success ? '✅ Completed (exit 0)' : `❌ Failed (exit ${code})`;
            appendLog(cardId, summary);
          }
        } else {
          summary = success ? '✅ Completed (no output)' : `❌ Failed (exit ${code}, no output)`;
          if (!success && stderrBuf) summary += ` — ${stderrBuf.substring(0, 200)}`;
          appendLog(cardId, summary);
        }

        finalize(success, summary);
      })().catch(e => {
        appendLog(cardId, `❌ Error in close handler: ${e.message}`);
        finalize(false, `❌ Internal error: ${e.message}`);
      });
    });

    return new Promise(resolve => {
      function finalize(success, summary) {
        if (finalized) return;
        finalized = true;
        clearTimeout(killTimer);

        const durationMs = Date.now() - startMs;
        appendLog(cardId, `[run] Finished in ${Math.round(durationMs / 1000)}s — success=${success}`);

        (async () => {
          const toColumn = success ? 'done' : 'todo';
          const moved = await self._moveCard(cardId, 'doing', toColumn, appendLog);
          if (!moved) {
            appendLog(cardId, `⚠️ Move to "${toColumn}" failed — patching status directly as fallback`);
          }

          const completedAt = new Date().toISOString();
          await self._patchCard(cardId, {
            agentStatus: success ? 'done' : 'failed',
            completedAt,
            completionSummary: summary || (success ? '✅ Completed' : '❌ Failed'),
            completionSuccess: success,
          }, appendLog);

          await self._setAgentStatus(agentId, 'idle', null, appendLog, cardId);

          try {
            onComplete(success);
          } catch (cbErr) {
            appendLog(cardId, `⚠️ onComplete callback error: ${cbErr.message}`);
          }

          resolve({ ok: true, success });
        })().catch(e => {
          appendLog(cardId, `❌ Cleanup error after finalize: ${e.message}`);
          resolve({ ok: false, error: e.message });
        });
      }
    });
  }

  async getRecentChanges() {
    this._initWorkspaces();
    const results = [];
    for (const ws of this.workspaces) {
      try {
        try {
          execSync(`/usr/bin/git -C "${ws.path}" rev-parse HEAD`, { encoding: 'utf8', stdio: 'pipe' });
        } catch {
          try {
            execSync(`/usr/bin/git -C "${ws.path}" init`, { encoding: 'utf8' });
            execSync(`/usr/bin/git -C "${ws.path}" config user.email "agent@openclaw"`, { encoding: 'utf8' });
            execSync(`/usr/bin/git -C "${ws.path}" config user.name "${ws.name}"`, { encoding: 'utf8' });
            execSync(`/usr/bin/git -C "${ws.path}" add -A`, { encoding: 'utf8' });
            execSync(`/usr/bin/git -C "${ws.path}" commit -m "init: workspace initialized for ${ws.name}"`, { encoding: 'utf8' });
            console.log(`[recent-changes] Auto-initialized git repo for ${ws.name} at ${ws.path}`);
          } catch (initErr) {
            console.warn(`[recent-changes] Git init failed for ${ws.name}: ${initErr.message}`);
          }
        }

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
    const hash = change.hash || change._hash;
    if (!hash) throw new Error('No hash in change');
    const fullHash = execSync(`/usr/bin/git -C "${ws.path}" rev-parse ${hash}`, { encoding: 'utf8', timeout: 5000 }).trim();
    return execSync(`/usr/bin/git -C "${ws.path}" show ${fullHash} -- "${filename}"`, { encoding: 'utf8', timeout: 5000 });
  }
}

module.exports = OpenClawAdapter;
