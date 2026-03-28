#!/bin/bash
cd "$(dirname "$0")"
node backend/sync.js
exec node backend/index.js
