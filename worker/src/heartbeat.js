'use strict';

/**
 * File-based liveness heartbeat for services without an HTTP port. The
 * service touches the file while it is healthy; the Docker HEALTHCHECK
 * (src/healthcheck.js) fails when the file is older than the allowed age.
 */
const fs = require('fs');

function startHeartbeat(file, isHealthy, intervalMs = 5000) {
  const beat = () => {
    try {
      if (isHealthy()) fs.writeFileSync(file, String(Date.now()));
    } catch {
      /* a failed heartbeat write simply makes the container unhealthy */
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startHeartbeat };
