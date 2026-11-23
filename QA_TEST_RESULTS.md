# QA Test Results

> **Template.** Every "Actual result" field is intentionally blank. Fill them in **only** with results you observed on your own machine. Paste real console output where asked. If a test fails, record the failure. Do not edit it into a pass.

## Test environment (fill in)

| Item | Value |
|---|---|
| Tester |  |
| Date |  |
| OS / version |  |
| Docker Desktop version (`docker version --format '{{.Server.Version}}'`) |  |
| Docker Compose version (`docker compose version`) |  |
| Node.js version (`node -v`) |  |
| Git commit tested (`git rev-parse --short HEAD`) |  |
| Changes to `.env` vs `.env.example` (no passwords!) |  |

## 0. Setup

```bash
cp .env.example .env
```

```bash
docker compose up --build -d
```

```bash
docker compose ps
```

**Expected:** `postgres`, `rabbitmq`, `api`, `outbox-publisher` and `worker` are `Up (healthy)`. `migrate` has `Exited (0)`.

**Actual result:**

```
(paste `docker compose ps` output)
```

## 1. Unit tests (no Docker needed)

```bash
cd api && npm ci && npm test && cd ..
```

```bash
cd worker && npm ci && npm test && cd ..
```

**Expected:** all API and worker unit tests pass.

| Suite | Expected | Actual (passed / total) | Notes |
|---|---|---|---|
| api |  all pass |  |  |
| worker | all pass |  |  |

## 2. End-to-end QA suite

Run all seven tests (about 4–6 minutes, because they stop and start containers):

```bash
cd tests && npm ci && npm test
```

Or run one at a time, for example `npm run test:03`.

> The suite kills and restarts containers. Do not run it against data you care about.

### TEST 1: Asynchronous decoupling (`npm run test:01`)

| Check | Expected | Actual |
|---|---|---|
| POST /api/jobs status | `202` |  |
| Response contains a UUID v4 `jobId`, `statusUrl` and `Location` header | yes |  |
| Status immediately after POST | `queued` or `processing` (never `completed`) |  |
| Observed status sequence | `queued -> processing -> completed` |  |
| Latency p50 / p95 / max over 10 requests (printed as `[TEST 1]`) | p95 < `QA_LATENCY_BUDGET_MS` (100 ms) | p50 = ___ ms, p95 = ___ ms, max = ___ ms |
| Pass / fail |  |  |

### TEST 2: Burst traffic (`npm run test:02`)

| Check | Expected | Actual |
|---|---|---|
| Worker containers / consumers / prefetch | 1 / 1 / `[1]` |  |
| All 5 POSTs | `202`, each in milliseconds |  |
| Status right after burst | at least 3 `queued` |  |
| Max observed queue depth | ≥ 2 |  |
| Processing windows overlap? | no (strictly sequential) |  |
| All 5 completed with `attempts = 1` | yes |  |
| Pass / fail |  |  |

### TEST 3: Worker crash recovery (`npm run test:03`)

| Check | Expected | Actual |
|---|---|---|
| Job A reached `processing` before the kill | yes |  |
| Two POSTs while worker is down | both `202` |  |
| Queue while worker is down | `consumers = 0`, `ready ≥ 3` |  |
| Job A status while worker is down | `processing`, `completedAt = null` |  |
| After `docker compose start worker` | A, B, C `completed` |  |
| Job A events | ≥ 2 `claimed` by different workers, exactly 1 `completed` |  |
| Main queue drained | `messages = 0` |  |
| Pass / fail |  |  |

### TEST 4: Idempotency (`npm run test:04`)

| Check | Expected | Actual |
|---|---|---|
| Two duplicate messages for a completed job | 2 × `duplicate_ignored` events |  |
| `claimed` / `completed` events | exactly 1 / exactly 1 |  |
| `attempts`, `completed_at`, result checksum | unchanged |  |
| Second `completed` event inserted manually | rejected with SQLSTATE `23505` |  |
| 10 concurrent claims | 1 `claimed`, 9 `locked` |  |
| Pass / fail |  |  |

### TEST 5: Retries and DLQ (`npm run test:05`)

| Check | Expected | Actual |
|---|---|---|
| `fail_then_succeed` job | `completed`, `attempts = 2`, `error.simulated = true` |  |
| Retry gap (printed) | ≥ 90 % of `RETRY_DELAY_MS` | ___ ms |
| `always_fail` job | `failed`, `attempts = MAX_ATTEMPTS`, `MAX_ATTEMPTS - 1` retries |  |
| DLQ message for that job | header `x-dead-letter-reason = max_attempts_exhausted` |  |
| Invalid-JSON message | in DLQ with reason `invalid_message` |  |
| Unknown-job message | in DLQ with reason `unknown_job` |  |
| Valid job afterwards | `completed`, `attempts = 1` |  |
| Pass / fail |  |  |

### TEST 6: Durability (`npm run test:06`)

| Check | Expected | Actual |
|---|---|---|
| Completed job after `docker compose restart api worker` | unchanged |  |
| Ready messages before broker restart | 3, queue `durable = true` |  |
| Ready messages after `docker compose restart rabbitmq` | ≥ 3 |  |
| Jobs after worker start | all `completed` |  |
| Pass / fail |  |  |

### TEST 7: Validation and security (`npm run test:07`)

| Check | Expected | Actual |
|---|---|---|
| Malformed JSON | `400 invalid_json` |  |
| Missing fields | `400` with field list |  |
| Unknown / malformed job ID | `404` / `400` |  |
| SQL injection in body | stored literally, `jobs` table intact |  |
| SQL injection in path/query | `400` |  |
| PostgreSQL stopped | POST, GET and health → `503`; recovers after start |  |
| RabbitMQ stopped | POST → `202`, outbox pending ≥ 1, job completes after start |  |
| Passwords in API responses | none |  |
| `.env` tracked by git / passwords in tracked files | no / none |  |
| Pass / fail |  |  |

### Full-suite summary

```
(paste the final Jest summary, e.g. "Tests: X passed, Y total")
```

## 3. Manual checks

| # | Procedure | Expected | Actual |
|---|---|---|---|
| M1 | Open http://localhost:3000, click **Submit Job** | Result box shows the job ID, `HTTP 202` and the response time; the row moves queued → processing → completed |  |
| M2 | Click **Submit 5 jobs rapidly** | 5 × 202 within milliseconds; Queued counter rises, then drains one by one |  |
| M3 | Select "Always fail", submit | Row ends `failed` with a red "Simulated failure" message after 3 attempts |  |
| M4 | Open http://localhost:15672 and log in with `RABBITMQ_USER` / `RABBITMQ_PASSWORD` from `.env` | Queues `reports.jobs`, `reports.jobs.retry` and `reports.jobs.dlq` exist and are durable ("D") |  |
| M5 | Submit a job, then within 2 s run `docker compose stop worker` | Worker log shows "Graceful shutdown started", then "Job completed", then "Worker stopped"; the job is `completed` |  |
| M6 | `docker compose up -d --scale worker=3`, then burst | Jobs processed in parallel by different `workerId`s, each completed once |  |
| M7 | Dashboard at a phone-sized browser width | Layout stacks into one column with no horizontal page scroll (the table scrolls inside its card) |  |

## 4. Defects found during testing

Record defects in [AI_AUDIT_LOG.md](AI_AUDIT_LOG.md) (section "Defects found") and reference their IDs here.

| Test | Defect ID | Summary |
|---|---|---|
|  |  |  |
