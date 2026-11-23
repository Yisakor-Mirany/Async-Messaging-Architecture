/* Async Report Jobs dashboard - plain JavaScript, no framework.
 * All dynamic values are inserted with textContent (never innerHTML) so
 * user-supplied data such as "requestedBy" cannot inject markup. */
(function () {
  'use strict';

  const POLL_MS = 1500;
  const HISTORY_LIMIT = 50;

  const $ = (id) => document.getElementById(id);
  const form = $('job-form');
  const submitBtn = $('submit-btn');
  const burstBtn = $('burst-btn');
  const resultBox = $('submit-result');
  const formError = $('form-error');
  const tbody = $('jobs-body');
  const autoRefresh = $('auto-refresh');
  const lastRefresh = $('last-refresh');

  const seenJobIds = new Set();
  let pollTimer = null;
  let refreshing = false;

  // ---------- helpers ----------
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function formatMs(ms) {
    if (ms === null || ms === undefined) return '–';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)} m ${Math.round((ms % 60000) / 1000)} s`;
  }

  function formatTime(iso) {
    if (!iso) return '–';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function todayMinus(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }

  function showError(message) {
    formError.textContent = message;
    formError.hidden = false;
  }

  function clearError() {
    formError.hidden = true;
    formError.textContent = '';
  }

  // ---------- submission ----------
  function buildRequestBody() {
    const data = new FormData(form);
    const body = {
      reportType: data.get('reportType'),
      parameters: {
        startDate: data.get('startDate'),
        endDate: data.get('endDate'),
        format: data.get('format'),
        includeCharts: data.get('includeCharts') === 'on',
      },
    };
    const requestedBy = String(data.get('requestedBy') || '').trim();
    if (requestedBy) body.requestedBy = requestedBy;
    const mode = data.get('simulate');
    if (mode && mode !== 'none') body.simulate = { mode, failAttempts: 1 };
    return body;
  }

  /** POST one job; resolves with timing info, never throws. */
  async function submitJob(body) {
    const started = performance.now();
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const latencyMs = performance.now() - started;
      const json = await res.json().catch(() => ({}));
      return { ok: res.status === 202, status: res.status, latencyMs, json, serverTiming: res.headers.get('Server-Timing') };
    } catch (err) {
      return { ok: false, status: 0, latencyMs: performance.now() - started, json: { message: err.message } };
    }
  }

  function describeFailure(r) {
    if (r.status === 0) return `Network error: ${r.json.message}`;
    const details = Array.isArray(r.json.details) ? r.json.details.map((d) => `• ${d.field}: ${d.message}`).join('\n') : '';
    return `HTTP ${r.status} ${r.json.error || ''} – ${r.json.message || 'Request failed'}${details ? `\n${details}` : ''}`;
  }

  function renderAccepted(results, label) {
    resultBox.replaceChildren();
    const accepted = results.filter((r) => r.ok);
    resultBox.appendChild(el('h3', { text: `${label}: ${accepted.length}/${results.length} accepted with HTTP 202` }));
    const list = el('ul');
    for (const r of results) {
      if (r.ok) {
        list.appendChild(el('li', null, [
          el('code', { text: r.json.jobId }),
          ` → HTTP ${r.status}, status "${r.json.status}", responded in `,
          el('strong', { text: formatMs(r.latencyMs) }),
        ]));
      } else {
        list.appendChild(el('li', { class: 'job-error', text: describeFailure(r) }));
      }
    }
    resultBox.appendChild(list);
    if (accepted.length) {
      resultBox.appendChild(el('p', {
        class: 'note',
        text: 'The response arrived before any processing happened (processing takes 3–5 s per job). '
          + 'Watch the status change from queued → processing → completed in the table below.',
      }));
    }
    resultBox.hidden = false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    submitBtn.disabled = true;
    const r = await submitJob(buildRequestBody());
    submitBtn.disabled = false;
    if (r.ok) {
      renderAccepted([r], 'Submitted');
    } else {
      resultBox.hidden = true;
      showError(describeFailure(r));
    }
    refresh();
  });

  burstBtn.addEventListener('click', async () => {
    clearError();
    burstBtn.disabled = true;
    const body = buildRequestBody();
    // Fire all five requests concurrently - none waits for processing.
    const results = await Promise.all(Array.from({ length: 5 }, () => submitJob(body)));
    burstBtn.disabled = false;
    renderAccepted(results, 'Burst of 5');
    refresh();
  });

  // ---------- history table ----------
  function statusCell(job) {
    const children = [el('span', { class: `badge badge--${job.status}`, text: job.status })];
    if (job.status === 'processing') {
      const bar = el('span');
      bar.style.width = `${job.progress}%`;
      children.push(el('div', { class: 'progress', title: `${job.progress}%` }, [bar]));
    }
    return el('td', null, children);
  }

  function detailsCell(job) {
    if (job.status === 'failed' && job.error) {
      const kind = job.error.simulated ? 'Simulated failure' : (job.error.category || 'Error');
      return el('td', { class: 'job-error', text: `${kind}: ${job.error.message}` });
    }
    if (job.status === 'completed' && job.result) {
      return el('td', { class: 'job-result', text: `${job.result.fileName} · ${job.result.rowCount} rows · ${job.result.pages} pages` });
    }
    if (job.error && job.status !== 'completed') {
      return el('td', { class: 'job-error', text: `Last attempt: ${job.error.message}` });
    }
    if (job.status === 'completed' && job.error) {
      return el('td', { class: 'job-result', text: `Recovered after: ${job.error.message}` });
    }
    return el('td', { class: 'muted', text: job.status === 'queued' ? 'Waiting in queue' : `${job.progress}%` });
  }

  function renderJobs(jobs) {
    if (!jobs.length) {
      tbody.replaceChildren(el('tr', null, [el('td', { colspan: '8', class: 'empty', text: 'No jobs yet. Submit one above.' })]));
      return;
    }
    const rows = jobs.map((job) => {
      const isNew = !seenJobIds.has(job.jobId);
      seenJobIds.add(job.jobId);
      return el('tr', { class: isNew ? 'is-new' : '' }, [
        el('td', { class: 'mono', title: job.jobId, text: job.jobId.slice(0, 8) }),
        el('td', { text: job.reportType.replace(/_/g, ' ') }),
        statusCell(job),
        el('td', { text: String(job.attempts) }),
        el('td', { text: formatTime(job.createdAt) }),
        el('td', { text: formatMs(job.queueWaitMs) }),
        el('td', { text: formatMs(job.processingMs) }),
        detailsCell(job),
      ]);
    });
    tbody.replaceChildren(...rows);
  }

  function renderStats(stats) {
    $('stat-queued').textContent = stats.jobs.queued;
    $('stat-processing').textContent = stats.jobs.processing;
    $('stat-completed').textContent = stats.jobs.completed;
    $('stat-failed').textContent = stats.jobs.failed;
    $('stat-outbox').textContent = stats.outbox.pending;
  }

  async function refreshHealth() {
    const dot = $('health-dot');
    const text = $('health-text');
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const body = await res.json();
      if (res.status === 200 && body.status === 'ok') {
        dot.className = 'dot dot--ok';
        text.textContent = `API healthy · DB ${body.checks.database.latencyMs} ms`;
      } else if (res.status === 200) {
        dot.className = 'dot dot--degraded';
        text.textContent = `Degraded · ${body.checks.outbox.pending} message(s) waiting in outbox (broker unreachable?)`;
      } else {
        dot.className = 'dot dot--down';
        text.textContent = 'API cannot reach the database';
      }
    } catch {
      dot.className = 'dot dot--down';
      text.textContent = 'API unreachable';
    }
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const [jobsRes, statsRes] = await Promise.all([
        fetch(`/api/jobs?limit=${HISTORY_LIMIT}`, { cache: 'no-store' }),
        fetch('/api/stats', { cache: 'no-store' }),
      ]);
      if (jobsRes.ok) renderJobs((await jobsRes.json()).jobs);
      if (statsRes.ok) renderStats(await statsRes.json());
      lastRefresh.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch {
      lastRefresh.textContent = 'Refresh failed – retrying';
    } finally {
      refreshing = false;
    }
    refreshHealth();
  }

  function schedulePolling() {
    clearInterval(pollTimer);
    if (autoRefresh.checked) pollTimer = setInterval(refresh, POLL_MS);
  }

  $('refresh-btn').addEventListener('click', refresh);
  autoRefresh.addEventListener('change', schedulePolling);

  // Sensible defaults: last 30 days.
  form.elements.startDate.value = todayMinus(30);
  form.elements.endDate.value = todayMinus(0);

  refresh();
  schedulePolling();
}());
