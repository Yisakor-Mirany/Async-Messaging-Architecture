'use strict';

/** Docker HEALTHCHECK: healthy when the heartbeat file was written recently. */
const fs = require('fs');

const file = process.env.HEARTBEAT_FILE || '/tmp/service.heartbeat';
const maxAgeMs = Number(process.env.HEARTBEAT_MAX_AGE_MS || 30000);

try {
  const last = Number(fs.readFileSync(file, 'utf8'));
  process.exit(Date.now() - last <= maxAgeMs ? 0 : 1);
} catch {
  process.exit(1);
}
