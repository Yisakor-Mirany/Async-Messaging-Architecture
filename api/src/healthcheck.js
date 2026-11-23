'use strict';

/**
 * Docker HEALTHCHECK helper: exits 0 when GET /api/health returns HTTP 200.
 * Uses Node's built-in http module so the image needs no curl/wget.
 */
const http = require('http');

const port = Number(process.env.API_INTERNAL_PORT || 3000);
const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 3000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
