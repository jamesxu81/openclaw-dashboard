// adapters/rest.js
// Generic REST API adapter — delegates external data fetching to a remote API.
// Configure via config.json adapter.rest section.

const https = require('https');
const http = require('http');
const url = require('url');

class RestAdapter {
  constructor(config) {
    this.cfg = config.adapter?.rest || {};
    this.baseUrl = (this.cfg.baseUrl || 'http://localhost:4000').replace(/\/$/, '');
    this.token = this.cfg.token || '';
  }

  async _fetch(endpoint, opts = {}) {
    const fullUrl = this.baseUrl + endpoint;
    const parsed = url.parse(fullUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return new Promise((resolve, reject) => {
      const req = lib.request({ ...parsed, headers, method: opts.method || 'GET' }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      });
      req.on('error', reject);
      if (opts.body) req.write(JSON.stringify(opts.body));
      req.end();
    });
  }

  // --- Cron jobs ---
  async getCronJobs() {
    const ep = this.cfg.cronJobsEndpoint || '/api/cron/jobs';
    try { return await this._fetch(ep); } catch { return []; }
  }

  // --- Cron history ---
  async getCronHistory({ limit = 100, since = null } = {}) {
    const ep = this.cfg.cronHistoryEndpoint || '/api/cron/history';
    const qs = new URLSearchParams({ limit });
    if (since) qs.set('since', since);
    try { return await this._fetch(`${ep}?${qs}`); } catch { return []; }
  }

  // --- Agent runner ---
  async runCard(card, cardId, appendLog, onComplete) {
    const ep = this.cfg.agentRunEndpoint || '/api/run';
    appendLog(cardId, `[rest] Delegating agent run to remote API...`);
    try {
      const result = await this._fetch(ep, {
        method: 'POST',
        body: { cardId, title: card.title, details: card.details, agentType: card.agentType }
      });
      if (result?.ok) {
        appendLog(cardId, `[rest] Remote agent started.`);
        onComplete(true);
      } else {
        appendLog(cardId, `[rest] Remote error: ${result?.error || 'unknown'}`);
        onComplete(false);
      }
    } catch (e) {
      appendLog(cardId, `[rest] ❌ ${e.message}`);
      onComplete(false);
    }
    return { ok: true };
  }

  // --- Recent changes ---
  async getRecentChanges() {
    const ep = this.cfg.recentChangesEndpoint || '/api/changes';
    try { return await this._fetch(ep); } catch { return []; }
  }

  async getFileDiff(changeIdx, filename, allChanges) {
    const ep = this.cfg.recentChangesEndpoint || '/api/changes';
    try {
      const result = await this._fetch(`${ep}/${changeIdx}/diff?file=${encodeURIComponent(filename)}`);
      return result?.diff || '';
    } catch { return ''; }
  }
}

module.exports = RestAdapter;
