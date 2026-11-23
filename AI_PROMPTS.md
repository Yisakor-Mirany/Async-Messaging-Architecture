# AI Prompt Log

This file records the prompts given to the AI assistant (Claude, via Claude Code) while building this project, as required by the assignment's academic-transparency rules.

- **Entry 1** is the initial prompt, copied verbatim. It produced the initial AI-generated implementation (the first commit on the development branch).
- Add each later prompt with the template at the bottom. **Do not** back-fill entries for conversations that did not happen.

---

## Entry 1: Initial prompt (verbatim)

- **Date:** 2026-11-23
- **Tool / model:** Claude Code (Anthropic Claude)
- **Purpose:** Generate the complete initial implementation and documentation.
- **Result:** Initial AI-generated draft of every file in this repository. See [AI_AUDIT_LOG.md](AI_AUDIT_LOG.md) for what still needs student review.

````text
Act as a senior distributed systems architect, backend engineer, and DevOps engineer.

I am completing my Week 06 college assignment on asynchronous messaging architecture, event-driven systems, message brokers, worker resilience, and distributed system reliability.

Build a complete, functional, well-documented project called "Async-Messaging-Architecture".

PROJECT GOAL
Create a real asynchronous background job processing application that demonstrates how a synchronous REST API can accept requests immediately while a RabbitMQ message broker distributes work to background consumers.

TECHNOLOGY STACK
- Node.js with Express
- RabbitMQ with the Management UI
- PostgreSQL for durable job status persistence and idempotency
- Docker Compose for local orchestration
- HTML, CSS, and vanilla JavaScript frontend
- Jest or an equivalent automated test framework
- GitHub-ready repository structure

APPLICATION WORKFLOW
Implement an asynchronous report generation system.

Users submit report generation requests through a dashboard. The API validates each request, assigns a unique job ID, persists the job, publishes a durable message to RabbitMQ, and returns HTTP 202 Accepted without waiting for processing.

A background worker consumes the message, simulates 3–5 seconds of report generation, updates PostgreSQL with job progress, and explicitly acknowledges successful processing.

The frontend polls the API and shows real-time job status updates.

1. REST API PRODUCER
Implement:
- POST /api/jobs
- GET /api/jobs/:id
- GET /api/jobs
- GET /api/health

POST /api/jobs requirements:
- Validate all incoming input using an appropriate schema validation library.
- Generate a UUID for each new job.
- Persist the job in PostgreSQL.
- Reliably publish the job to RabbitMQ.
- Return HTTP 202 Accepted with the job ID and status endpoint.
- Do not wait for the background worker to finish.
- Target a sub-100ms response locally under normal conditions, and include a measured latency test rather than guaranteeing it.
- Return appropriate HTTP errors for invalid input and infrastructure failures.
- Implement a transactional outbox or an equivalently documented reliable publishing strategy to avoid losing a job if database persistence succeeds but RabbitMQ publishing fails.
- Use publisher confirms and explain their limitations.

2. RABBITMQ MESSAGE BROKER
Configure RabbitMQ using Docker Compose.

Requirements:
- Durable queues and persistent messages.
- Manual message acknowledgments.
- Durable dead-letter queue.
- Explicit dead-letter exchange routing.
- Configurable prefetch, defaulting to 1.
- Retry handling for transient failures using bounded attempts.
- Retry delays without immediate infinite requeue loops.
- Clear separation between main queue, retry queue, and dead-letter queue.
- RabbitMQ Management UI accessible locally at http://localhost:15672.
- Configuration through environment variables.
- Persistent Docker volumes for broker state.
- Explain at-least-once delivery semantics.

3. BACKGROUND WORKER CONSUMER
Implement a separate Node.js worker service that:
- Consumes messages from RabbitMQ.
- Simulates report processing for 3–5 seconds.
- Updates job status from queued to processing to completed.
- Explicitly ACKs messages only after successful durable completion.
- Uses NACK/requeue appropriately for recoverable infrastructure problems.
- Routes repeatedly failing or invalid messages to the DLQ.
- Implements configurable bounded retries.
- Handles worker shutdown gracefully.
- Recovers unacknowledged messages after an abrupt worker crash.
- Uses PostgreSQL-based idempotency so redelivered messages do not repeat completed work.
- Uses atomic database state transitions or appropriate locking to prevent concurrent consumers from processing the same job.
- Distinguishes simulated failures from real infrastructure errors.
- Does not falsely mark work completed before the underlying operation succeeds.

4. POSTGRESQL STATUS STORE
Create a database schema containing:
- Job UUID
- Report type
- Request payload
- Current status
- Attempt count
- Created timestamp
- Started timestamp
- Completed timestamp
- Error details
- Optional result data

Requirements:
- Database migrations or initialization SQL.
- Appropriate constraints and indexes.
- Persistent Docker volume.
- Safe parameterized SQL queries.
- Document how duplicate messages are identified.
- Provide consistent status recovery after restarts.
- Document handling of interrupted processing attempts and poison messages.

5. FRONTEND DASHBOARD
Build a polished, responsive dashboard with:
- Report submission form.
- Submit Job button.
- Immediate display of Job ID and HTTP 202 response.
- Job history table.
- Status badges for queued, processing, completed, and failed.
- Automatic status polling every 1–2 seconds.
- Job duration and timestamps.
- Error display for failed jobs.
- Manual refresh button.
- A button to submit 5 jobs rapidly for burst testing.
- Clear visual confirmation that API submission does not block on background processing.

Use plain HTML, CSS, and JavaScript. Do not introduce unnecessary frontend frameworks.

6. DOCKER COMPOSE
Create a working docker-compose.yml with:
- API service
- Worker service
- RabbitMQ service
- PostgreSQL service
- Outbox publisher service if required by the chosen implementation

Requirements:
- Buildable Dockerfiles.
- Health checks.
- Named persistent volumes.
- Service startup dependencies.
- Restart policies.
- Environment configuration.
- Non-root application processes where practical.
- No hardcoded production credentials.
- .env.example with documented local development settings.
- .gitignore excluding actual secrets.
- Simple startup command: docker compose up --build -d.

7. AUTOMATED QA TEST SUITE
Implement meaningful automated tests and scripts for:

TEST 1: ASYNCHRONOUS DECOUPLING
- Submit a report generation job.
- Verify HTTP 202 Accepted.
- Verify response includes a UUID.
- Measure response latency.
- Verify eventual status progression to completed.

TEST 2: BURST TRAFFIC
- Submit at least 5 jobs rapidly.
- Confirm successful ingestion.
- Demonstrate queue buffering.
- Verify controlled sequential processing when worker prefetch and concurrency are both set to 1.
- Verify all jobs eventually complete.

TEST 3: WORKER CRASH RECOVERY
- Stop or forcibly kill the worker during processing.
- Submit two more jobs while the worker is unavailable.
- Verify ingestion continues working.
- Restart the worker.
- Verify queued and unacknowledged jobs resume and complete.
- Verify no jobs are lost.

TEST 4: IDEMPOTENCY
- Redeliver the same job message.
- Verify the job is not processed twice after successful completion.
- Confirm state transitions remain consistent.

TEST 5: RETRIES AND DEAD-LETTER QUEUE
- Simulate a transient failure.
- Verify bounded retry behavior.
- Submit a poison message in a controlled test.
- Verify the message enters the DLQ after exhausting its retry policy.
- Verify the worker continues processing valid jobs.

TEST 6: DURABILITY
- Restart the API and worker.
- Verify job status persists.
- Restart the message broker and confirm durable pending messages survive.

TEST 7: API VALIDATION AND SECURITY
- Test malformed request bodies.
- Test missing required fields.
- Test unknown job IDs.
- Test database and broker connection failures.
- Test that SQL injection inputs do not execute.
- Verify no secrets are exposed in API responses or committed files.

Also include a QA_TEST_RESULTS.md template with commands, expected outcomes, and blank actual-result fields. Do not invent passing test results.

8. ARCHITECTURE AUDIT
Create ARCHITECTURE_AUDIT.md.

Document:
- Why this is a real asynchronous messaging system rather than a fake in-memory queue.
- Why HTTP 202 is returned before processing completes.
- Why durable queues and persistent messages matter.
- Why explicit ACK/NACK handling matters.
- How worker crash recovery works.
- How idempotency prevents duplicate side effects.
- How bounded retries and DLQ routing work.
- How outbox publishing addresses database/broker dual-write failures.
- At-least-once delivery trade-offs.
- Eventual consistency and operational complexity.

IMPORTANT FOR ACADEMIC TRANSPARENCY:
This assignment requires an AI-generated initial draft followed by an audit.

Create an AI_AUDIT_LOG.md that identifies areas requiring manual inspection and provides space to record actual defects found and manually corrected.

Do not invent mistakes, manual corrections, or completed tests. Clearly distinguish initial AI-generated code from later student-reviewed changes.

9. README.md
Create a professional GitHub README containing:
- Project overview.
- Technology stack.
- Architecture diagram using Mermaid.
- Explanation of producer, broker, worker, and status store.
- Complete directory structure.
- Prerequisites.
- Environment setup.
- Docker Compose startup commands.
- Frontend access URL.
- RabbitMQ Management UI access instructions.
- Sample curl requests and expected responses.
- Status polling examples.
- Commands to inspect queues and worker logs.
- Commands to stop and restart the worker.
- QA execution instructions.
- ACK/NACK, retry, DLQ, and idempotency explanations.
- Troubleshooting section.
- AI disclosure explaining that Claude generated the initial implementation and the student is responsible for verification.
- Links to AI_PROMPTS.md, ARCHITECTURE_AUDIT.md, AI_AUDIT_LOG.md, and QA_TEST_RESULTS.md.

10. AI PROMPT LOG
Create AI_PROMPTS.md.

Include this initial prompt verbatim and provide a template for recording follow-up prompts and fixes.

Do not invent future conversations or claim that student verification has occurred.

11. GITHUB REPOSITORY STRUCTURE
Use a clean, professional directory structure with separate API, worker, frontend, database, and tests directories.

Include all required configuration files:
- package.json and lockfiles where applicable
- Dockerfiles
- docker-compose.yml
- .env.example
- .gitignore
- README.md
- AI_PROMPTS.md
- ARCHITECTURE_AUDIT.md
- AI_AUDIT_LOG.md
- QA_TEST_RESULTS.md

12. DELIVERABLE REQUIREMENTS
- Provide complete functional source code.
- Do not use pseudocode or TODO placeholders for essential functionality.
- Keep the implementation manageable for a college assignment.
- Prioritize correctness, durability, and auditability over unnecessary features.
- Use clean coding practices and helpful comments.
- Avoid unnecessary paid cloud services.
- Make everything runnable locally using Docker Desktop.
- Provide exact commands for building, starting, testing, stopping, and resetting the application.
- Do not fabricate execution results or claim the application has been tested unless tests were actually run.
- No video recording instructions are needed.

WORKFLOW
First, present the architecture and proposed file structure.

Then generate every required file with its complete contents.

After generating the implementation, perform a static self-audit against the assignment requirements, identify any unverified behavior, and explain how I should validate it locally.

Finally, provide a short, numbered setup and testing guide suitable for a beginner using VS Code, Docker Desktop, Git, and GitHub.

Do not skip essential requirements or shorten the code with placeholders.

The final project must be ready for me to run, audit, test, and publish to GitHub after verifying it locally.
````

---

## Follow-up prompts

_None recorded yet. Add an entry for every later prompt, including prompts that produced code you rejected._

### Template (copy for each new entry)

```markdown
## Entry N: <short title>

- **Date:**
- **Tool / model:**
- **Prompt (verbatim):**

  > paste the exact prompt here

- **Why I asked:** (defect found, missing requirement, question, ...)
- **What the AI changed or answered:** (files, functions, summary)
- **What I accepted / rejected / modified by hand, and why:**
- **How I verified it:** (command run + actual result, or "not yet verified")
- **Related AI_AUDIT_LOG.md entry:** (ID, e.g. D-01)
```
