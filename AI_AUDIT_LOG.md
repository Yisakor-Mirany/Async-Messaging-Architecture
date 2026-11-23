# AI Audit Log

This log separates the **AI-generated initial draft** from **later student-reviewed changes**, as the assignment's academic-transparency rules require.

- **Baseline:** the first commit on the development branch is the unmodified AI-generated draft (Claude, via Claude Code). Record its hash below so later diffs can be shown with `git diff <baseline>..HEAD`.
- **Rule:** only record defects you actually found and corrections you actually made. Leave sections empty rather than inventing entries.

| Item | Value |
|---|---|
| Baseline commit (AI draft) | `__________` (fill in with `git log --oneline`, the first commit) |
| Student reviewer |  |
| Review started (date) |  |
| Review finished (date) |  |

---

## Part A: What the AI itself ran (not student verification)

This section is the AI's own disclosure. It is included because the assignment forbids fabricated results, so the reader should know exactly what was and was not executed when the draft was generated.

While generating the draft, the AI ran the project in its own Linux cloud sandbox, not on the student's computer:

- `npm test` in `api/` and in `worker/`: unit tests ran and passed in that sandbox.
- `docker compose up --build -d`, then the full QA suite in `tests/` (`npm test`): all 7 test files (27 tests) ran in 01→07 order and passed against a freshly built stack with empty volumes in that sandbox (about 3.5 minutes).
- Manual spot checks in that sandbox:
  - graceful worker stop mid-job (the job completed before exit)
  - `--scale worker=3` (9 jobs, each completed once, spread over 3 workers)
  - a headless-browser render of the dashboard (desktop and phone width, no console errors)

**Sandbox-specific deviation.** The sandbox's network uses a TLS-intercepting proxy, so the images were built through a temporary Compose override that added that proxy's CA certificate to `npm ci`. The override was not committed and the committed Dockerfiles were not changed. Image builds through the committed Dockerfiles alone were therefore **not** exercised by the AI, and they must be verified on the student's machine.

**None of the above counts as student verification.** Results can differ on Windows/macOS Docker Desktop (timing, file permissions, port conflicts, CPU speed affecting the latency budget). Record your own results in [QA_TEST_RESULTS.md](QA_TEST_RESULTS.md).

**Not executed by the AI at all:**
- the GitHub Actions workflow (`.github/workflows/ci.yml`) on GitHub
- the helper shell scripts in `scripts/` on Windows (Git Bash or WSL)
- `scripts/reset.sh`

---

## Part B: Areas requiring manual inspection

Tick each item when you have reviewed it, and write what you checked. These are the places where subtle bugs in distributed systems typically hide.

### B1. Correctness of the delivery guarantees

- [ ] **ACK only after commit**: `worker/src/handler.js`. Confirm that no code path calls `broker.ack` before the PostgreSQL transition has committed (or before the retry/DLQ copy is confirmed).
- [ ] **Claim SQL**: `worker/src/jobRepository.js#claimJob`. Check the `WHERE` clause. Can a `completed` or `failed` job ever be claimed? Can two workers both win?
- [ ] **Lease handling**: is `JOB_LEASE_MS` (10 s) safely larger than the gap between progress updates (about 1 s)? What happens if a database write stalls longer than the lease?
- [ ] **Same-process reclaim**: `locked_by = $2` in the claim lets the same process re-take its own job after an infrastructure NACK. Check that the in-memory `inFlightJobs` set prevents concurrent duplicates when `WORKER_PREFETCH > 1`.
- [ ] **Outbox relay**: `worker/src/outbox-publisher.js#publishBatch`. Check the ROLLBACK paths, the `returned` (unroutable) handling, and what happens if `waitForConfirms` hangs.
- [ ] **Reconciler**: could it re-enqueue jobs during a long but legitimate backlog? Is that acceptable (duplicates are ignored)?
- [ ] **Infrastructure error classification**: `worker/src/errors.js#isInfrastructureError`. Could a real bug be misclassified as infrastructure and requeued forever?

### B2. Database

- [ ] Check constraints in `001_initial_schema.sql`. Do they match every transition in `jobRepository.js`? (A mismatch shows up as a `23514` error in the worker logs.)
- [ ] Indexes: are they appropriate for `GET /api/jobs` (ordered by `created_at`) and for the outbox scan?
- [ ] All SQL is parameterised: search the code for string-built SQL. The only interpolation is the constant `LEASE_SQL` fragment.
- [ ] Unbounded growth of `job_events` and `outbox` (there is no retention job). Is that acceptable for the assignment?

### B3. RabbitMQ configuration

- [ ] Queue arguments (`x-dead-letter-exchange`, `x-message-ttl`) in `worker/src/rabbit.js` match the documentation.
- [ ] `hostname: rabbitmq` is set (it is required for persistence across container re-creation).
- [ ] Behaviour after changing `RETRY_DELAY_MS` (PRECONDITION_FAILED), documented in README Troubleshooting.

### B4. API and security

- [ ] Validation rules in `api/src/validation.js` (date limits, enum values, `.strict()`).
- [ ] `ALLOW_FAILURE_SIMULATION`: the compose default is `false`, but `.env.example` sets `true` for the demo. Is that acceptable?
- [ ] Error handler in `api/src/app.js` never returns stack traces or connection details.
- [ ] CSP / helmet settings do not break the dashboard.
- [ ] No authentication on the API (out of scope, but should be acknowledged).

### B5. Docker and operations

- [ ] Images build on your machine with the committed Dockerfiles (see Part A: not exercised by the AI).
- [ ] Containers run as the non-root `node` user (`docker compose exec api id`).
- [ ] Ports are bound to `127.0.0.1` (except the API on 3000). Check that nothing conflicts on your machine.
- [ ] `docker compose up --build -d` works on a completely fresh clone, with no existing volumes.

### B6. Tests

- [ ] Are any QA assertions timing-sensitive on a slower laptop (latency budget, retry gap, 15 s queue-depth watch)?
- [ ] Do the destructive tests (stop postgres or rabbitmq) always restore the stack, even when they fail?
- [ ] Does TEST 2 really prove sequential processing, or could it pass by luck?

### B7. Documentation

- [ ] Every command in README.md works as written on your OS.
- [ ] ARCHITECTURE_AUDIT.md claims match the code (spot-check at least five).

---

## Part C: Defects found

Only real findings. Use one row per defect. Severity: **High** = data loss or wrong status, **Medium** = incorrect behaviour that recovers, **Low** = cosmetic or documentation.

| ID | Date | Found by (test/review) | File(s) | Description | Severity | Status |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |

## Part D: Manual corrections made by the student

Describe each change you made after the AI draft. Reference the defect ID and the commit.

| ID | Commit | Files changed | What was changed and why | Verified how (command + actual result) |
|---|---|---|---|---|
|  |  |  |  |  |

## Part E: Changes made with further AI assistance

If you asked the AI to fix something, log the prompt in [AI_PROMPTS.md](AI_PROMPTS.md) and summarise it here.

| ID | AI_PROMPTS entry | Commit | Summary | Reviewed and accepted by student? |
|---|---|---|---|---|
|  |  |  |  |  |

## Part F: Reviewer sign-off

- [ ] I have read every file listed in Part B.
- [ ] I ran the unit tests and the QA suite myself and recorded the results in QA_TEST_RESULTS.md.
- [ ] All defects in Part C are fixed, or are explicitly documented as known limitations.

Signature / date: ______________________
