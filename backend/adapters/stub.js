// adapters/stub.js
// Demo/no-op adapter — runs without any external dependencies.
// Perfect for development, demos, and testing.

class StubAdapter {
  constructor(config) {
    this.config = config.adapter?.stub || {};
    this.fakeRuns = [
      { jobId: 'demo-job-1', jobName: 'Daily Briefing', ts: Date.now() - 3600000, status: 'ok', summary: 'Sent morning briefing email.', durationMs: 12400, runAtMs: Date.now() - 3600000, nextRunAtMs: Date.now() + 82800000, model: 'claude-haiku', tokens: 2400 },
      { jobId: 'demo-job-2', jobName: 'Market News', ts: Date.now() - 7200000, status: 'ok', summary: 'Fetched 8 articles from 3 sources.', durationMs: 8200, runAtMs: Date.now() - 7200000, nextRunAtMs: Date.now() + 86400000, model: 'claude-haiku', tokens: 1800 },
    ];
    this.fakeJobs = [
      { id: 'demo-job-1', name: 'Daily Briefing', enabled: true, schedule: { expr: '0 9 * * *' }, state: { nextRunAtMs: Date.now() + 82800000, lastStatus: 'ok' }, agentId: 'research-agent' },
      { id: 'demo-job-2', name: 'Market News', enabled: true, schedule: { expr: '0 8 * * 1-5' }, state: { nextRunAtMs: Date.now() + 86400000, lastStatus: 'ok' }, agentId: 'research-agent' },
    ];
  }

  // --- Cron jobs & history ---
  async getCronJobs() { return this.fakeJobs; }
  async getCronHistory({ limit = 100, since = null } = {}) {
    let runs = this.fakeRuns;
    if (since) runs = runs.filter(r => r.ts >= since);
    return runs.slice(0, limit);
  }

  // --- Agent runner ---
  async runCard(card, cardId, appendLog, onComplete) {
    appendLog(cardId, `[stub] Simulating agent run for: ${card.title}`);
    setTimeout(() => {
      appendLog(cardId, `[stub] ✅ Agent completed (simulated). Awaiting review.`);
      onComplete(true);
    }, 2000);
    return { ok: true };
  }

  // --- Recent changes ---
  async getRecentChanges() {
    return [
      {
        workspace: 'demo-workspace',
        hash: 'abc1234',
        message: 'feat: add kanban card completion timestamps',
        date: new Date(Date.now() - 1800000).toISOString(),
        files: ['frontend/index.html', 'backend/index.js'],
        diffStat: '2 files changed, 14 insertions(+), 3 deletions(-)'
      }
    ];
  }

  async getFileDiff(changeIdx, filename, allChanges) {
    return `--- a/${filename}\n+++ b/${filename}\n@@ -1,3 +1,4 @@\n // stub diff\n+// new line added\n  existing line\n  another line`;
  }
}

module.exports = StubAdapter;
