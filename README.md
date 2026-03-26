# Mission Control Board

A self-hosted AI agent dashboard. **Kanban, Cron Jobs, Team, Office, Settings, and Daily Digest** — all in one place.

![screenshot placeholder](https://via.placeholder.com/900x500?text=Mission+Control+Board)

## Features

- 📅 **Cron Jobs** — View scheduled jobs, run history, status, next run time
- 🗂 **Kanban Board** — Drag-and-drop task management with agent execution
- 🤖 **Team** — Live agent status, task history, logs
- 🏢 **Office** — Animated pixel-art office layout showing agent activity
- 📋 **Daily Digest** — Summary of today's runs, completed tasks, recent code changes
- ⚙️ **Settings** — Tool permissions and toggles
- 🔌 **Adapter Pattern** — Swap backends without touching frontend code

---

## Quick Start

### Option 1: Docker (recommended)

```bash
docker compose up -d
```

Open http://localhost:3001

### Option 2: Node.js

```bash
npm install
npm start
```

Open http://localhost:3001

---

## Configuration

Edit `config.json` to set your adapter and preferences:

```json
{
  "backend": {
    "adapter": "stub"   // "stub" | "openclaw" | "rest"
  }
}
```

Or set the env var:

```bash
MC_ADAPTER=openclaw npm start
```

---

## Adapters

### `stub` (default)
No external dependencies. Runs demo data. Perfect for development and demos.

### `openclaw`
Reads cron history from `~/.openclaw/cron/`, recent changes from git workspaces, and launches agents via the `openclaw` CLI.

Configure in `config.json`:
```json
{
  "adapter": {
    "openclaw": {
      "binPath": "/opt/homebrew/bin/openclaw",
      "workspaceRoot": "/Users/you/.openclaw/workspace",
      "cronDir": "/Users/you/.openclaw/cron",
      "workspaces": [
        { "name": "workspace", "path": "/Users/you/.openclaw/workspace" },
        { "name": "workspace-coding-agent", "path": "/Users/you/.openclaw/workspace-coding-agent" }
      ],
      "agents": [
        { "id": "coding-agent", "model": "github-copilot/claude-sonnet-4.6" },
        { "id": "research-agent", "model": "github-copilot/claude-haiku-4.5" }
      ]
    }
  }
}
```

### `rest`
Delegates cron/agent/changes data to a remote REST API.

Configure in `config.json`:
```json
{
  "adapter": {
    "rest": {
      "baseUrl": "http://your-api-server:4000",
      "token": "your-bearer-token",
      "agentRunEndpoint": "/api/run",
      "cronHistoryEndpoint": "/api/cron/history",
      "cronJobsEndpoint": "/api/cron/jobs",
      "recentChangesEndpoint": "/api/changes"
    }
  }
}
```

---

## Project Structure

```
mission-control-board/
├── backend/
│   ├── index.js              # Express API server (adapter-aware)
│   ├── sync.js               # Data seeding on startup
│   └── adapters/
│       ├── stub.js           # Demo/no-op adapter
│       ├── openclaw.js       # OpenClaw-specific adapter
│       └── rest.js           # Generic REST API adapter
├── frontend/
│   ├── index.html            # Single-page app (all tabs)
│   └── avatars/              # Agent avatar images
├── data/
│   └── data.json             # Kanban/settings persistence (auto-created)
├── config.json               # Configuration
├── package.json
├── Dockerfile
└── docker-compose.yml
```

---

## Writing a Custom Adapter

Create `backend/adapters/myadapter.js`:

```js
class MyAdapter {
  constructor(config) { /* read config.adapter.myadapter */ }
  async getCronJobs() { return []; }
  async getCronHistory({ limit, since }) { return []; }
  async runCard(card, cardId, appendLog, onComplete) { onComplete(true); return { ok: true }; }
  async getRecentChanges() { return []; }
  async getFileDiff(changeIdx, filename, allChanges) { return ''; }
}
module.exports = MyAdapter;
```

Then set `"adapter": "myadapter"` in `config.json`.

---

## License

MIT
