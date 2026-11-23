'use strict';

/**
 * Loads the repository's .env so the QA suite uses the same credentials and
 * ports as Docker Compose. Nothing here is printed to the console.
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '..', '..');
const envFile = path.join(repoRoot, '.env');
if (!fs.existsSync(envFile)) {
  throw new Error('No .env file found in the repository root. Run: cp .env.example .env');
}
const fileEnv = dotenv.parse(fs.readFileSync(envFile));
const get = (name, fallback) => process.env[name] ?? fileEnv[name] ?? fallback;

const env = {
  repoRoot,
  apiUrl: get('QA_API_URL', `http://localhost:${get('API_PORT', '3000')}`),
  latencyBudgetMs: Number(get('QA_LATENCY_BUDGET_MS', '100')),
  maxAttempts: Number(get('MAX_ATTEMPTS', '3')),
  retryDelayMs: Number(get('RETRY_DELAY_MS', '3000')),
  prefetch: Number(get('WORKER_PREFETCH', '1')),
  postgres: {
    host: get('QA_POSTGRES_HOST', '127.0.0.1'),
    port: Number(get('POSTGRES_HOST_PORT', '5433')),
    user: get('POSTGRES_USER'),
    password: get('POSTGRES_PASSWORD'),
    database: get('POSTGRES_DB'),
  },
  rabbitmq: {
    hostname: get('QA_RABBITMQ_HOST', '127.0.0.1'),
    port: Number(get('RABBITMQ_AMQP_HOST_PORT', '5672')),
    managementUrl: `http://${get('QA_RABBITMQ_HOST', '127.0.0.1')}:${get('RABBITMQ_MANAGEMENT_HOST_PORT', '15672')}`,
    username: get('RABBITMQ_USER'),
    password: get('RABBITMQ_PASSWORD'),
    vhost: get('RABBITMQ_VHOST', '/'),
    exchange: get('RABBITMQ_EXCHANGE', 'reports'),
    routingKey: get('RABBITMQ_ROUTING_KEY', 'report.generate'),
    mainQueue: get('RABBITMQ_QUEUE', 'reports.jobs'),
    retryQueue: get('RABBITMQ_RETRY_QUEUE', 'reports.jobs.retry'),
    deadLetterQueue: get('RABBITMQ_DLQ', 'reports.jobs.dlq'),
  },
  secrets: [get('POSTGRES_PASSWORD'), get('RABBITMQ_PASSWORD')].filter(Boolean),
};

module.exports = { env };
