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
    this.binPath = this.cfg.binPath || '/opt/homebrew/bin/openclaw';
    this.mcBase = this.cfg.mcBase || 'http://localhost:3002';
    this.agentModels = {};
    (this.cfg.agents || []).forEach(a => { this.agentModels[a.id] = a.model; });
    // Build workspaces from config + auto-discover from openclaw.json
    this._initWorkspaces();
  }

  _initWorkspaces() {
    const home = process.env.HOME;
    const ocPath = path.join(home, '.openclaw', 'openclaw.json');
    const wsSet = new Map();
    // Always include main workspace
    wsSet.set('workspace', { name: 'workspace', path: path.join(home, '.openclaw', 'workspace') });
    // Load from openclaw.json agent workspaces
    if (fs.existsSync(ocPath)) {
      try {
        const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
        for (const a of (oc.agents?.list || [])) {
          if (a.workspace) wsSet.set(a.id, { name: a.id, path: a.workspace });
        }
      } catch {}
    }
    // Also include any manually configured workspaces from config.json
    for (const ws of (this.cfg.workspaces || [])) {
      if (ws.path) wsSet.set(ws.name, { name: ws.name, path: ws.path });
    }
    this.workspaces = Array.from(wsSet.values());
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

  async runCard(card, cardId, appendLog, onComplete) {
    return new Promise(async (resolve) => {
      const agentType = card.agentType || 'research';
      // Map card agentType to real OpenClaw agent id
      // Support both short names (coding, research) and full ids (coding-agent, test-agent)
      const agentId = (() => {
        if (agentType === 'coding') return 'coding-agent';
        if (agentType === 'research') return 'research-agent';
        // Already a full agent id
        return agentType;
      })();

      const hotRules = this._readHotForAgent(agentId);
      const prompt = [
        hotRules
          ? `Before doing anything else, read and obey these HOT rules for this agent. Keep them in mind throughout the task.\n\n${hotRules}`
          : null,
        card.details ? `${card.title}\n\nDetails:\n${card.details}` : card.title,
      ].filter(Boolean).join('\n\n---\n\n');
      const mcBase = this.mcBase;

      appendLog(cardId, `🚀 Assigning to agent: ${agentId}`);
      if (hotRules) {
        appendLog(cardId, `🧠 HOT rules injected from ${this._getHotPathForAgent(agentId)}`);
      } else {
        appendLog(cardId, `ℹ️ No HOT.md found for ${agentId}; running without HOT injection`);
      }

      // 1. Update agent status → running BEFORE spawning
      try {
        const patchRes = await fetch(`${mcBase}/api/agents/${agentId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'running', currentTask: card.title }),
        });
        if (patchRes.ok) {
          appendLog(cardId, `✅ Agent ${agentId} status → running`);
        } else {
          appendLog(cardId, `⚠️ Could not update agent status (${patchRes.status})`);
        }
      } catch (e) {
        appendLog(cardId, `⚠️ Agent status update failed: ${e.message}`);
      }

      // 2. Spawn the agent via openclaw agent CLI (synchronous, returns JSON)
      const sessionId = `kanban-${cardId}`;
      const args = [
        'agent',
        '--agent', agentId,
        '--session-id', sessionId,
        '--message', prompt,
        '--json',
      ];

      appendLog(cardId, `⚙️ Running: openclaw agent --agent ${agentId} --session-id ${sessionId}`);

      const proc = spawn(this.binPath, args, {
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` }
      });

      let stdoutBuf = '';
      let stderrBuf = '';

      proc.stdout.on('data', d => { stdoutBuf += d.toString(); });
      proc.stderr.on('data', d => {
        const line = d.toString().trim();
        // Filter out config warning noise
        if (line && !line.startsWith('Config warnings') && !line.includes('plugin disabled')) {
          stderrBuf += line + '\n';
          appendLog(cardId, '[stderr] ' + line.substring(0, 300));
        }
      });

      proc.on('error', async e => {
        appendLog(cardId, `❌ Failed to start agent: ${e.message}`);
        // Reset agent status → idle
        try {
          await fetch(`${mcBase}/api/agents/${agentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'idle', currentTask: null }),
          });
        } catch {}
        onComplete(false);
        resolve({ ok: false });
      });

      proc.on('close', code => {
        (async () => {
          let success = code === 0;
          let summary = '';

          // Parse JSON output from openclaw agent --json
          if (stdoutBuf.trim()) {
            try {
              const json = JSON.parse(stdoutBuf.trim());
              if (json.status === 'ok') {
                success = true;
                summary = json.result?.meta ? `✅ Done in ${json.result.meta.durationMs}ms` : '✅ Completed';
                // Log agent reply text if available
                const payloads = json.result?.payloads || [];
                for (const p of payloads) {
                  if (p.text) appendLog(cardId, `💬 Agent reply: ${p.text.substring(0, 500)}`);
                }
              } else {
                success = false;
                summary = `❌ Agent returned status: ${json.status}`;
              }
              appendLog(cardId, summary);
            } catch {
              // Not JSON or partial — treat raw output as log
              const lines = stdoutBuf.trim().split('\n');
              for (const line of lines) {
                if (line.trim()) appendLog(cardId, line.substring(0, 300));
              }
              summary = success ? '✅ Completed (exit 0)' : `❌ Failed (exit ${code})`;
              appendLog(cardId, summary);
            }
          } else {
            summary = success ? '✅ Completed (no output)' : `❌ Failed (exit ${code}, no output)`;
            appendLog(cardId, summary);
          }

          // 3. Move card: doing → done (success) or doing → todo (failure)
          const toColumn = success ? 'done' : 'todo';
          appendLog(cardId, `[DEBUG] About to call card move API...`);
          try {
            const moveUrl = `${mcBase}/api/kanban/move`;
            appendLog(cardId, `[DEBUG] Move URL: ${moveUrl}`);
            const moveBody = JSON.stringify({ fromColumn: 'doing', toColumn, cardId });
            appendLog(cardId, `[DEBUG] Move body: ${moveBody}`);
            
            const moveRes = await fetch(moveUrl, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: moveBody,
            });
            
            appendLog(cardId, `[DEBUG] Move response status: ${moveRes.status}`);
            if (moveRes.ok) {
              appendLog(cardId, `📋 Card moved → ${toColumn}`);
            } else {
              appendLog(cardId, `⚠️ Card move failed (${moveRes.status})`);
            }
          } catch (e) {
            appendLog(cardId, `⚠️ Card move error: ${e.message}`);
          }

          // 4. Reset agent status → idle
          try {
            await fetch(`${mcBase}/api/agents/${agentId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'idle', currentTask: null }),
            });
            appendLog(cardId, `🔵 Agent ${agentId} status → idle`);
          } catch (e) {
            appendLog(cardId, `⚠️ Could not reset agent status: ${e.message}`);
          }

          onComplete(success);
          resolve({ ok: true });
        })();
      });
    });
  }

  // --- Recent changes ---
  async getRecentChanges() {
    // Re-discover workspaces each call (picks up newly added agents)
    this._initWorkspaces();
    const results = [];
    for (const ws of this.workspaces) {
      try {
        // Auto-init git repo if empty (no commits yet)
        try {
          execSync(`/usr/bin/git -C "${ws.path}" rev-parse HEAD`, { encoding: 'utf8', stdio: 'pipe' });
        } catch {
          // No commits — init and commit
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
    // Get full hash from short hash
    const fullHash = execSync(`/usr/bin/git -C "${ws.path}" rev-parse ${hash}`, { encoding: 'utf8', timeout: 5000 }).trim();
    return execSync(`/usr/bin/git -C "${ws.path}" show ${fullHash} -- "${filename}"`, { encoding: 'utf8', timeout: 5000 });
  }
}

module.exports = OpenClawAdapter;
