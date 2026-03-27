#!/bin/bash
cd /Users/luckbot/.openclaw/workspace-coding-agent/mission-control-board
/opt/homebrew/bin/node backend/sync.js
exec /opt/homebrew/bin/node backend/index.js
