import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const variant = 'supplier-matched-v4-candidate';
const inputVariants = ['supplier-derived-v3', 'supplier-derived-v2'];
const legacyMaterialFiles = ['base-texture.jpg', 'black-texture.jpg', 'gold-texture.jpg', 'accent-texture.jpg'];

function publicJob(job) {
  return {
    id: job.id,
    sku: job.sku,
    fault: job.fault,
    scopes: job.scopes,
    model: job.model,
    status: job.status,
    progress: job.progress,
    message: job.message,
    events: job.events,
    result: job.result,
  };
}

function publicBatch(batch) {
  return {
    id: batch.id, status: batch.status, model: batch.model,
    routingPolicy: batch.routingPolicy || null,
    prompt: batch.prompt, createdAt: batch.createdAt, updatedAt: batch.updatedAt,
    current: batch.current, total: batch.items.length, message: batch.message,
    items: batch.items,
  };
}

function publicBenchmark(benchmark) {
  return {
    id: benchmark.id, status: benchmark.status, models: benchmark.models,
    prompt: benchmark.prompt, createdAt: benchmark.createdAt, updatedAt: benchmark.updatedAt,
    current: benchmark.current, total: benchmark.runs.length, message: benchmark.message,
    runs: benchmark.runs, recommendation: benchmark.recommendation || null,
  };
}

export default function mouldingMaterialReview() {
  const root = process.cwd();
  const jobs = new Map();
  const batches = new Map();
  const benchmarks = new Map();
  let active = null;
  let modelCache = { at: 0, model: null, models: [], error: null };
  const jobsRoot = resolve(root, '.material-review-jobs');
  const batchesRoot = resolve(root, '.material-review-batches');
  const benchmarksRoot = resolve(root, '.material-review-benchmarks');
  const routingPolicyPath = resolve(root, '.material-review-routing-policy.json');
  const statePath = resolve(root, '.material-review-state.json');
  const python = join(root, '.venv/bin/python');
  const pipeline = join(root, 'tools/moulding-material-pilot/quality_pipeline.py');

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const eligible = sku => {
    const assetRoot = join(root, 'public/assets/mouldings', sku);
    return existsSync(assetRoot) && (inputVariants.some(name =>
      existsSync(join(assetRoot, 'variants', name, 'basecolor.jpg'))) ||
      legacyMaterialFiles.some(name => existsSync(join(assetRoot, name))));
  };
  const readState = () => {
    try { return JSON.parse(readFileSync(statePath, 'utf8')); }
    catch { return { schemaVersion: 1, mouldings: {} }; }
  };
  const writeState = state => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  const save = job => {
    mkdirSync(job.dir, { recursive: true });
    writeFileSync(join(job.dir, 'job.json'), JSON.stringify(publicJob(job), null, 2));
  };
  const saveBatch = batch => {
    batch.updatedAt = new Date().toISOString();
    const dir = join(batchesRoot, batch.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'batch.json'), JSON.stringify(publicBatch(batch), null, 2));
    batches.set(batch.id, batch);
  };
  const readBatch = id => {
    const file = join(batchesRoot, id, 'batch.json');
    if (batches.has(id) && !existsSync(file)) {
      batches.delete(id);
      return null;
    }
    if (batches.has(id)) return batches.get(id);
    if (!existsSync(file)) return null;
    try {
      const batch = JSON.parse(readFileSync(file, 'utf8'));
      if (['running', 'pausing'].includes(batch.status)) {
        const interrupted = batch.items.find(item => item.status === 'running');
        if (interrupted) {
          interrupted.status = 'queued'; interrupted.progress = 0;
          interrupted.message = 'Ready to restart after the local server was reopened.';
        }
        batch.status = 'paused';
        batch.message = 'Batch recovered. Press Resume to continue from the first unfinished moulding.';
        saveBatch(batch);
      }
      batches.set(id, batch);
      return batch;
    } catch { return null; }
  };
  const latestBatch = () => {
    if (!existsSync(batchesRoot)) return null;
    const ids = readdirSync(batchesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .sort((a, b) => statSync(join(batchesRoot, b.name)).mtimeMs - statSync(join(batchesRoot, a.name)).mtimeMs);
    return ids.length ? readBatch(ids[0].name) : null;
  };
  const readRoutingPolicy = () => {
    try { return JSON.parse(readFileSync(routingPolicyPath, 'utf8')); }
    catch { return null; }
  };
  const benchmarkStats = benchmark => benchmark.models.map(model => {
    const runs = benchmark.runs.filter(run => run.model === model && ['complete', 'failed'].includes(run.status));
    const completed = runs.filter(run => run.status === 'complete' && run.result);
    const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const imageScores = completed.map(run => Math.max(0, ...(run.result.attempts || []).map(attempt => Number(attempt.deterministicScore || 0))));
    const confidences = completed.map(run => Number(run.result.reviewer?.confidence || 0) * 100);
    const colourErrors = completed.map(run => Number(run.result.bestMetrics?.colourDeltaE)).filter(Number.isFinite);
    const durations = completed.map(run => Number(run.durationMs)).filter(value => Number.isFinite(value) && value > 0);
    const rated = completed.filter(run => ['accepted', 'rejected'].includes(run.humanDecision));
    return { model, finished: runs.length, completed: completed.length,
      passed: completed.filter(run => run.result.status === 'automated-approved-candidate').length,
      humanRated: rated.length, humanAccepted: rated.filter(run => run.humanDecision === 'accepted').length,
      averageImageScore: average(imageScores), averageConfidence: average(confidences),
      averageColourDeltaE: average(colourErrors), averageDurationMs: average(durations) };
  });
  const recommendModels = benchmark => {
    const stats = benchmarkStats(benchmark).filter(item => item.completed > 0);
    if (!stats.length) return null;
    const quality = [...stats].sort((a, b) =>
      (b.humanRated ? b.humanAccepted / b.humanRated : b.passed / Math.max(1, b.completed)) -
        (a.humanRated ? a.humanAccepted / a.humanRated : a.passed / Math.max(1, a.completed)) ||
      Number(b.averageImageScore || 0) - Number(a.averageImageScore || 0) ||
      Number(b.averageConfidence || 0) - Number(a.averageConfidence || 0));
    const best = quality[0];
    const qualityRate = item => item.humanRated ? item.humanAccepted / item.humanRated : item.passed / Math.max(1, item.completed);
    const bestPassRate = qualityRate(best);
    const primaryCandidates = stats.filter(item =>
      qualityRate(item) >= Math.max(0, bestPassRate - .1));
    const primary = [...primaryCandidates].sort((a, b) =>
      Number(a.averageDurationMs || Infinity) - Number(b.averageDurationMs || Infinity))[0] || best;
    return { primaryModel: primary.model, fallbackModel: best.model,
      reason: primary.model === best.model
        ? 'This model currently has the strongest combined pass rate and image score.'
        : 'The primary is the fastest model within ten percentage points of the best pass rate; the fallback has the strongest quality result.' };
  };
  const saveBenchmark = benchmark => {
    benchmark.updatedAt = new Date().toISOString();
    benchmark.recommendation = recommendModels(benchmark);
    const dir = join(benchmarksRoot, benchmark.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'benchmark.json'), JSON.stringify(publicBenchmark(benchmark), null, 2));
    benchmarks.set(benchmark.id, benchmark);
  };
  const readBenchmark = id => {
    const file = join(benchmarksRoot, id, 'benchmark.json');
    if (benchmarks.has(id) && !existsSync(file)) {
      benchmarks.delete(id);
      return null;
    }
    if (benchmarks.has(id)) return benchmarks.get(id);
    if (!existsSync(file)) return null;
    try {
      const benchmark = JSON.parse(readFileSync(file, 'utf8'));
      if (['running', 'pausing'].includes(benchmark.status)) {
        const interrupted = benchmark.runs.find(run => run.status === 'running');
        if (interrupted) {
          interrupted.status = 'queued'; interrupted.progress = 0;
          interrupted.message = 'Ready to restart after the local server was reopened.';
        }
        benchmark.status = 'paused';
        benchmark.message = 'Benchmark recovered. Press Resume to continue.';
        saveBenchmark(benchmark);
      }
      benchmarks.set(id, benchmark);
      return benchmark;
    } catch { return null; }
  };
  const latestBenchmark = () => {
    if (!existsSync(benchmarksRoot)) return null;
    const ids = readdirSync(benchmarksRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .sort((a, b) => statSync(join(benchmarksRoot, b.name)).mtimeMs - statSync(join(benchmarksRoot, a.name)).mtimeMs);
    return ids.length ? readBenchmark(ids[0].name) : null;
  };
  const readPersisted = id => {
    const file = join(jobsRoot, id, 'job.json');
    if (!existsSync(file)) return null;
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      const job = { ...stored, dir: join(jobsRoot, id) };
      if (job.status === 'running') {
        job.status = 'failed';
        job.message = 'The visualiser server restarted before this review finished. Start it again.';
        writeFileSync(file, JSON.stringify(publicJob(job), null, 2));
      }
      jobs.set(id, job);
      return job;
    } catch { return null; }
  };
  async function localModels() {
    if (Date.now() - modelCache.at < 10000) return modelCache;
    try {
      const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const installed = (await response.json()).models || [];
      const knownVision = ['qwen3.8', 'qwen3.5', 'qwen3-vl', 'ministral-3', 'mistral-small3', 'gemma3', 'minicpm-v', 'llava', 'llama3.2-vision'];
      const candidates = installed.filter(item => knownVision.some(prefix => item.name.toLowerCase().includes(prefix)));
      const inspected = await Promise.all(candidates.map(async item => {
        try {
          const detail = await fetch('http://127.0.0.1:11434/api/show', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: item.name }), signal: AbortSignal.timeout(2500),
          });
          const data = detail.ok ? await detail.json() : {};
          const explicit = Array.isArray(data.capabilities) ? data.capabilities.includes('vision') : null;
          const textOnlyGemma = /gemma3:(270m|1b)(?:-|$)/i.test(item.name);
          return !textOnlyGemma && explicit !== false ? item : null;
        } catch { return /gemma3:(270m|1b)(?:-|$)/i.test(item.name) ? null : item; }
      }));
      const models = inspected.filter(Boolean)
        .map(item => ({ name: item.name, size: item.size, parameterSize: item.details?.parameter_size || '' }));
      const preferred = ['qwen3.8', 'qwen3.5', 'qwen3-vl', 'ministral-3', 'mistral-small3.2', 'gemma3', 'minicpm-v4.5', 'llava', 'llama3.2-vision'];
      const model = preferred.flatMap(prefix => models.filter(item => item.name.toLowerCase().includes(prefix)))[0]?.name;
      if (!model) throw new Error('No supported Ollama vision model is installed.');
      modelCache = { at: Date.now(), model, models, error: null };
    } catch (error) {
      modelCache = { at: Date.now(), model: null, models: [], error: error.message || 'Ollama is unavailable.' };
    }
    return modelCache;
  }
  const summary = (report, versionId = report.outputVariant) => ({
    sku: report.sku,
    status: report.status,
    requestedFault: report.requestedFault,
    inputVariant: report.inputVariant,
    outputVariant: report.outputVariant,
    bestMetrics: report.bestMetrics,
    bestFailedGates: report.bestFailedGates,
    bestSettings: report.bestSettings,
    correctionPlan: report.correctionPlan || null,
    attempts: (report.attempts || []).map(item => ({
      attempt: item.attempt,
      deterministicScore: item.deterministicScore,
      failedGates: item.failedGates,
      observations: item.agentReview?.observations || [],
      blockers: item.agentReview?.blockers || [],
      agentScore: item.agentReview?.score,
    })),
    analyst: report.agents?.analyst,
    reviewer: report.agents?.reviewer,
    model: report.agents?.model,
    reviewScopes: report.reviewScopes || ['material'],
    referenceImages: report.referenceImages || [],
    familyReferenceImages: report.familyReferenceImages || [],
    profile: report.profile,
    profileGate: report.profileGate,
    revision: Date.now(),
    versionId,
    createdAt: report.createdAt,
  });
  const historyFor = sku => {
    const variantsRoot = join(root, 'public/assets/mouldings', sku, 'variants');
    if (!existsSync(variantsRoot)) return [];
    const decisions = readState().mouldings?.[sku]?.versions || {};
    return readdirSync(variantsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && (entry.name.startsWith('review-') || entry.name === variant))
      .map(entry => {
        const reportPath = join(variantsRoot, entry.name, 'quality-report.json');
        try {
          const result = summary(JSON.parse(readFileSync(reportPath, 'utf8')), entry.name);
          return { ...result, decision: decisions[entry.name] || 'pending',
            createdAt: result.createdAt || statSync(reportPath).mtime.toISOString() };
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  };

  const launchReview = ({ sku, fault, scopes, model, fastReview = false }, onSettled) => {
    if (active) throw new Error('Another moulding is already being reviewed.');
    const id = randomUUID();
    const outputVariant = `review-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${id.slice(0, 8)}`;
    const job = { id, sku, fault, scopes, model, dir: join(jobsRoot, id), status: 'running',
      progress: 2, message: 'Starting local material review…', events: [], result: null };
    jobs.set(id, job); active = id; save(job);
    const args = [pipeline, '--sku', sku, '--fault', fault, '--ollama-model', model, '--output-variant', outputVariant,
      '--review-scopes', scopes.join(','), '--max-attempts', '4'];
    if (fastReview) args.push('--fast-review');
    const child = spawn(python, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', notified = false;
    const notifySettled = () => { if (!notified) { notified = true; onSettled?.(job); } };
    const output = chunk => {
      const text = chunk.toString();
      log = (log + text).slice(-50000);
      for (const line of text.split(/\r?\n/)) {
        const marker = line.match(/^MATERIAL_PROGRESS (\d+) (.+)$/);
        if (!marker) continue;
        job.progress = Number(marker[1]);
        job.message = marker[2];
        if (job.events.at(-1)?.message !== job.message)
          job.events.push({ progress: job.progress, message: job.message, at: new Date().toISOString() });
        save(job);
      }
    };
    child.stdout.on('data', output); child.stderr.on('data', output);
    const timer = setTimeout(() => child.kill('SIGTERM'), 20 * 60 * 1000);
    child.on('error', error => {
      clearTimeout(timer); active = null; job.status = 'failed';
      job.message = `Could not start material review: ${error.message}`; save(job);
      notifySettled();
    });
    child.on('close', code => {
      clearTimeout(timer); active = null;
      writeFileSync(join(job.dir, 'review.log'), log);
      const reportPath = join(root, 'public/assets/mouldings', sku, 'variants', outputVariant, 'quality-report.json');
      try { job.result = summary(JSON.parse(readFileSync(reportPath, 'utf8'))); } catch {}
      job.status = code === 0 && job.result ? 'complete' : 'failed';
      job.progress = job.status === 'complete' ? 100 : job.progress;
      job.message = job.status === 'complete'
        ? (job.result.status === 'automated-approved-candidate' ? 'Review passed. The candidate is ready to inspect.' : 'Review finished. The candidate needs your inspection.')
        : 'Material processing failed. See the review log for details.';
      save(job); notifySettled();
    });
    return job;
  };

  const continueBatch = batch => {
    if (batch.status !== 'running' || active) return;
    const item = batch.items.find(candidate => candidate.status === 'queued');
    if (!item) {
      batch.status = 'complete'; batch.current = batch.items.length;
      const passed = batch.items.filter(candidate => candidate.result?.status === 'automated-approved-candidate').length;
      const inspect = batch.items.filter(candidate => candidate.status === 'complete').length - passed;
      const failed = batch.items.filter(candidate => candidate.status === 'failed').length;
      batch.message = `Batch complete · ${passed} passed · ${inspect} need inspection${failed ? ` · ${failed} failed` : ''}`;
      saveBatch(batch); return;
    }
    item.status = 'running'; item.progress = 2; item.message = 'Starting…';
    batch.current = batch.items.indexOf(item) + 1;
    batch.message = `${item.sku} · ${item.name}`; saveBatch(batch);
    try {
      const selectedModel = item.nextModel || batch.routingPolicy?.primaryModel || batch.model;
      item.activeModel = selectedModel;
      const job = launchReview({ sku: item.sku, fault: item.prompt, scopes: item.scopes,
        model: selectedModel, fastReview: true }, settled => {
        item.jobId = settled.id; item.progress = settled.progress; item.message = settled.message;
        item.modelRuns ||= [];
        item.modelRuns.push({ model: selectedModel, jobId: settled.id, status: settled.status,
          result: settled.result || null, completedAt: new Date().toISOString() });
        const fallback = batch.routingPolicy?.fallbackModel;
        const needsFallback = fallback && fallback !== selectedModel && selectedModel === batch.routingPolicy?.primaryModel &&
          (settled.status !== 'complete' || settled.result?.status !== 'automated-approved-candidate');
        if (needsFallback) {
          item.status = 'queued'; item.progress = 0; item.result = null; item.nextModel = fallback;
          item.message = `Primary model requested inspection. Escalated to ${fallback}.`;
          if (batch.status === 'pausing') {
            batch.status = 'paused'; batch.message = 'Paused before the fallback model.';
            saveBatch(batch); return;
          }
          saveBatch(batch); setTimeout(() => continueBatch(batch), 25); return;
        }
        item.status = settled.status; item.result = settled.result || null;
        if (batch.status === 'pausing') {
          batch.status = 'paused'; batch.message = 'Paused after the current moulding completed.';
          saveBatch(batch); return;
        }
        saveBatch(batch); setTimeout(() => continueBatch(batch), 25);
      });
      item.jobId = job.id;
      const mirror = setInterval(() => {
        if (job.status !== 'running') return clearInterval(mirror);
        item.progress = job.progress; item.message = job.message; saveBatch(batch);
      }, 1200);
      saveBatch(batch);
    } catch (error) {
      item.status = 'failed'; item.message = error.message || 'Could not start review.';
      saveBatch(batch); setTimeout(() => continueBatch(batch), 25);
    }
  };

  const continueBenchmark = benchmark => {
    if (benchmark.status !== 'running' || active) return;
    const run = benchmark.runs.find(candidate => candidate.status === 'queued');
    if (!run) {
      benchmark.status = 'complete'; benchmark.current = benchmark.runs.length;
      const completed = benchmark.runs.filter(candidate => candidate.status === 'complete').length;
      const passed = benchmark.runs.filter(candidate => candidate.result?.status === 'automated-approved-candidate').length;
      benchmark.message = `Benchmark complete · ${completed}/${benchmark.runs.length} completed · ${passed} passed automatically.`;
      saveBenchmark(benchmark); return;
    }
    run.status = 'running'; run.progress = 2; run.message = 'Starting benchmark run…';
    run.startedAt = new Date().toISOString();
    benchmark.current = benchmark.runs.indexOf(run) + 1;
    benchmark.message = `${run.model} · ${run.sku}`; saveBenchmark(benchmark);
    try {
      const job = launchReview({ sku: run.sku, fault: run.prompt, scopes: run.scopes,
        model: run.model, fastReview: true }, settled => {
        run.jobId = settled.id; run.progress = settled.progress; run.message = settled.message;
        run.status = settled.status; run.result = settled.result || null;
        run.completedAt = new Date().toISOString();
        run.durationMs = Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt));
        if (benchmark.status === 'pausing') {
          benchmark.status = 'paused'; benchmark.message = 'Paused after the current benchmark run completed.';
          saveBenchmark(benchmark); return;
        }
        saveBenchmark(benchmark); setTimeout(() => continueBenchmark(benchmark), 25);
      });
      run.jobId = job.id;
      const mirror = setInterval(() => {
        if (job.status !== 'running') return clearInterval(mirror);
        run.progress = job.progress; run.message = job.message; saveBenchmark(benchmark);
      }, 1200);
      saveBenchmark(benchmark);
    } catch (error) {
      run.status = 'failed'; run.message = error.message || 'Could not start benchmark run.';
      run.completedAt = new Date().toISOString();
      saveBenchmark(benchmark); setTimeout(() => continueBenchmark(benchmark), 25);
    }
  };

  const attach = server => { server.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const path = url.pathname;
    if (!path.startsWith('/api/material-review')) return next();
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress))
      return send(res, 403, { error: 'Material review is available on this computer only.' });
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
        return send(res, 403, { error: 'Origin mismatch.' });
    } catch { return send(res, 403, { error: 'Invalid origin.' }); }

    if (path === '/api/material-review' && req.method === 'GET') {
      const sku = (url.searchParams.get('sku') || '').toUpperCase();
      const model = await localModels();
      const reportPath = join(root, 'public/assets/mouldings', sku, 'variants', variant, 'quality-report.json');
      let existing = null;
      try { existing = summary(JSON.parse(readFileSync(reportPath, 'utf8'))); } catch {}
      const state = readState().mouldings?.[sku] || {};
      return send(res, 200, { available: !!model.model && existsSync(python) && existsSync(pipeline),
        model: model.model, models: model.models, error: model.error, busy: !!active, eligible: eligible(sku), existing,
        history: historyFor(sku), assetStatus: state.assetStatus || 'pending', acceptedVersion: state.acceptedVersion || null,
        routingPolicy: readRoutingPolicy() });
    }
    if (path === '/api/material-review/statuses' && req.method === 'GET') {
      const state = readState();
      const catalogueRoot = join(root, 'public/assets/mouldings');
      const catalogueSkus = readdirSync(catalogueRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory()).map(entry => entry.name);
      const statuses = Object.fromEntries(catalogueSkus.map(sku => {
        const value = state.mouldings?.[sku] || {};
        const history = historyFor(sku);
        const accepted = value.acceptedVersion
          ? history.find(item => item.versionId === value.acceptedVersion)
          : null;
        return [sku, { assetStatus: value.assetStatus || 'pending', acceptedVersion: value.acceptedVersion || null,
          acceptedProfile: accepted?.profile?.points || null,
          acceptedRevision: accepted?.createdAt ? Date.parse(accepted.createdAt) : null,
          eligible: eligible(sku), versionCount: history.length }];
      }));
      return send(res, 200, { statuses });
    }
    if (path === '/api/material-review/batch' && req.method === 'GET') {
      const requested = url.searchParams.get('id');
      const batch = requested ? readBatch(requested) : latestBatch();
      return send(res, 200, { batch: batch ? publicBatch(batch) : null });
    }
    if (path === '/api/material-review/batch' && req.method === 'POST') {
      if (active) return send(res, 409, { error: 'The current moulding must finish before a batch can start.' });
      let body;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 300000) throw new Error('Batch request is too large.'); chunks.push(chunk); }
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch (error) { return send(res, 400, { error: error.message || 'Invalid batch request.' }); }
      const available = await localModels();
      const requestedModel = String(body.model || '');
      const routingPolicy = requestedModel === '__tiered__' ? readRoutingPolicy() : null;
      const model = requestedModel === '__tiered__'
        ? routingPolicy?.primaryModel
        : available.models.find(item => item.name === requestedModel)?.name;
      const primaryAvailable = !routingPolicy?.primaryModel || available.models.some(item => item.name === routingPolicy.primaryModel);
      const fallbackAvailable = !routingPolicy?.fallbackModel || available.models.some(item => item.name === routingPolicy.fallbackModel);
      if (!model || !primaryAvailable || !fallbackAvailable) return send(res, 503, { error: available.error || 'Select an installed Ollama vision model.' });
      const incoming = Array.isArray(body.items) ? body.items.slice(0, 150) : [];
      const items = incoming.map(value => {
        const sku = String(value.sku || '').toUpperCase().trim();
        const scopes = [...new Set(Array.isArray(value.scopes) ? value.scopes : [])].filter(scope => ['profile', 'material'].includes(scope));
        const prompt = String(value.prompt || body.prompt || '').trim();
        return { sku, name: String(value.name || sku), supplier: String(value.supplier || ''), scopes,
          prompt, status: 'queued', progress: 0, message: 'Queued', jobId: null, result: null };
      }).filter(item => /^[A-Z0-9-]{2,32}$/.test(item.sku) && eligible(item.sku) && item.scopes.length && item.prompt.length >= 4);
      if (!items.length) return send(res, 400, { error: 'No eligible mouldings with a review prompt were supplied.' });
      const id = randomUUID();
      const batch = { id, status: 'paused', model: routingPolicy ? `Tiered · ${routingPolicy.primaryModel} → ${routingPolicy.fallbackModel}` : model,
        routingPolicy, prompt: String(body.prompt || ''),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), current: 0,
        message: 'Queue prepared. Inspect the frames and prompts, then press Start batch.' , items };
      saveBatch(batch);
      return send(res, 202, publicBatch(batch));
    }
    const batchAction = path.match(/^\/api\/material-review\/batch\/([a-f0-9-]{36})\/(pause|resume)$/);
    if (batchAction && req.method === 'POST') {
      const batch = readBatch(batchAction[1]);
      if (!batch) return send(res, 404, { error: 'Batch was not found.' });
      if (batchAction[2] === 'pause') {
        const running = batch.items.some(item => item.status === 'running');
        batch.status = running ? 'pausing' : 'paused';
        batch.message = running ? 'Pausing after the current moulding…' : 'Batch paused.';
      } else if (batch.status !== 'complete') {
        if (active) return send(res, 409, { error: 'Another local review is currently running.' });
        batch.status = 'running'; batch.message = 'Resuming saved batch…';
        for (const item of batch.items) if (item.status === 'running') {
          item.status = 'queued'; item.progress = 0; item.message = 'Queued to restart';
        }
      }
      saveBatch(batch);
      if (batch.status === 'running') setTimeout(() => continueBatch(batch), 25);
      return send(res, 200, publicBatch(batch));
    }
    if (path === '/api/material-review/benchmark' && req.method === 'GET') {
      const requested = url.searchParams.get('id');
      const benchmark = requested ? readBenchmark(requested) : latestBenchmark();
      return send(res, 200, { benchmark: benchmark ? publicBenchmark(benchmark) : null,
        routingPolicy: readRoutingPolicy() });
    }
    if (path === '/api/material-review/benchmark' && req.method === 'POST') {
      if (active) return send(res, 409, { error: 'The current moulding must finish before a benchmark can be prepared.' });
      let body;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 300000) throw new Error('Benchmark request is too large.'); chunks.push(chunk); }
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch (error) { return send(res, 400, { error: error.message || 'Invalid benchmark request.' }); }
      const available = await localModels();
      const requestedModels = [...new Set(Array.isArray(body.models) ? body.models.map(String) : [])].slice(0, 6);
      const models = requestedModels.filter(name => available.models.some(item => item.name === name));
      if (!models.length) return send(res, 503, { error: available.error || 'Select at least one installed vision model.' });
      const incoming = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
      const items = incoming.map(value => {
        const sku = String(value.sku || '').toUpperCase().trim();
        return { sku, name: String(value.name || sku), supplier: String(value.supplier || ''),
          scopes: ['profile', 'material'], prompt: String(value.prompt || body.prompt || '').trim() };
      }).filter(item => /^[A-Z0-9-]{2,32}$/.test(item.sku) && eligible(item.sku) && item.prompt.length >= 4);
      if (!items.length) return send(res, 400, { error: 'No eligible benchmark mouldings were supplied.' });
      const id = randomUUID();
      const runs = items.flatMap(item => models.map(model => ({ ...item, model, status: 'queued',
        progress: 0, message: 'Queued', jobId: null, result: null, durationMs: null })));
      const benchmark = { id, status: 'paused', models, prompt: String(body.prompt || ''), runs,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), current: 0,
        message: `Benchmark prepared · ${items.length} mouldings × ${models.length} models. Press Start benchmark.` };
      saveBenchmark(benchmark);
      return send(res, 202, publicBenchmark(benchmark));
    }
    const benchmarkAction = path.match(/^\/api\/material-review\/benchmark\/([a-f0-9-]{36})\/(pause|resume|adopt|rate)$/);
    if (benchmarkAction && req.method === 'POST') {
      const benchmark = readBenchmark(benchmarkAction[1]);
      if (!benchmark) return send(res, 404, { error: 'Benchmark was not found.' });
      const action = benchmarkAction[2];
      if (action === 'rate') {
        let body;
        try { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { return send(res, 400, { error: 'Invalid benchmark rating.' }); }
        const run = benchmark.runs.find(item => item.sku === String(body.sku || '').toUpperCase() && item.model === String(body.model || ''));
        if (!run || run.status !== 'complete' || !run.result || !['accepted', 'rejected', 'pending'].includes(body.decision))
          return send(res, 400, { error: 'Choose a completed benchmark result and a valid decision.' });
        run.humanDecision = body.decision;
        saveBenchmark(benchmark);
        return send(res, 200, publicBenchmark(benchmark));
      }
      if (action === 'adopt') {
        if (benchmark.status !== 'complete') return send(res, 409, { error: 'Finish the benchmark before adopting its routing policy.' });
        if (!benchmark.recommendation) return send(res, 409, { error: 'Complete at least one benchmark result before adopting a routing policy.' });
        const policy = { ...benchmark.recommendation, benchmarkId: benchmark.id, createdAt: new Date().toISOString() };
        writeFileSync(routingPolicyPath, JSON.stringify(policy, null, 2) + '\n');
        return send(res, 200, { benchmark: publicBenchmark(benchmark), routingPolicy: policy });
      }
      if (action === 'pause') {
        const running = benchmark.runs.some(run => run.status === 'running');
        benchmark.status = running ? 'pausing' : 'paused';
        benchmark.message = running ? 'Pausing after the current benchmark run…' : 'Benchmark paused.';
      } else if (benchmark.status !== 'complete') {
        if (active) return send(res, 409, { error: 'Another local review is currently running.' });
        benchmark.status = 'running'; benchmark.message = 'Resuming benchmark…';
        for (const run of benchmark.runs) if (run.status === 'running') {
          run.status = 'queued'; run.progress = 0; run.message = 'Queued to restart';
        }
      }
      saveBenchmark(benchmark);
      if (benchmark.status === 'running') setTimeout(() => continueBenchmark(benchmark), 25);
      return send(res, 200, publicBenchmark(benchmark));
    }
    const match = path.match(/^\/api\/material-review\/([a-f0-9-]{36})$/);
    if (match && req.method === 'GET') {
      const job = jobs.get(match[1]) || readPersisted(match[1]);
      if (!job) return send(res, 404, { error: 'Material review job was not found.' });
      return send(res, 200, publicJob(job));
    }
    if (path === '/api/material-review/decision' && req.method === 'POST') {
      let body;
      try { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return send(res, 400, { error: 'Invalid review decision.' }); }
      const sku = String(body.sku || '').toUpperCase();
      if (!/^[A-Z0-9-]{2,32}$/.test(sku)) return send(res, 400, { error: 'Invalid moulding.' });
      const state = readState();
      const item = state.mouldings[sku] ||= { assetStatus: 'pending', acceptedVersion: null, versions: {} };
      if (['accepted', 'needs-work', 'pending'].includes(body.assetStatus)) item.assetStatus = body.assetStatus;
      if (body.versionId && ['accepted', 'rejected', 'pending'].includes(body.decision)) {
        item.versions ||= {}; item.versions[body.versionId] = body.decision;
        if (body.decision === 'accepted') {
          item.acceptedVersion = body.versionId; item.assetStatus = 'accepted';
          for (const id of Object.keys(item.versions)) if (id !== body.versionId && item.versions[id] === 'accepted') item.versions[id] = 'superseded';
        } else if (item.acceptedVersion === body.versionId) item.acceptedVersion = null;
      }
      item.updatedAt = new Date().toISOString(); writeState(state);
      return send(res, 200, { sku, ...item, history: historyFor(sku) });
    }
    if (path !== '/api/material-review' || req.method !== 'POST')
      return send(res, 404, { error: 'Unknown material-review endpoint.' });
    if (active) return send(res, 409, { error: 'Another moulding is already being reviewed.' });
    let body;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16000) throw new Error('Review request is too large.');
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch (error) { return send(res, 400, { error: error.message || 'Invalid review request.' }); }
    const sku = String(body.sku || '').toUpperCase().trim();
    const fault = String(body.fault || '').trim();
    const scopes = [...new Set(Array.isArray(body.scopes) ? body.scopes : [])]
      .filter(scope => ['profile', 'material'].includes(scope));
    if (!/^[A-Z0-9-]{2,32}$/.test(sku) || !existsSync(join(root, 'public/assets/mouldings', sku)))
      return send(res, 400, { error: 'Choose a valid moulding.' });
    if (!eligible(sku)) return send(res, 400, { error: `${sku} has no usable local material image to refine.` });
    if (fault.length < 4 || fault.length > 4000)
      return send(res, 400, { error: 'Describe the visible fault in 4 to 4000 characters.' });
    if (!scopes.length) return send(res, 400, { error: 'Add a profile or texture and colour review to the prompt.' });
    const available = await localModels();
    const requestedModel = String(body.model || '');
    const model = available.models.find(item => item.name === requestedModel)?.name;
    if (!model) return send(res, 503, { error: available.error || 'Select an installed Ollama vision model.' });
    const job = launchReview({ sku, fault, scopes, model });
    return send(res, 202, publicJob(job));
  }); };
  return { name: 'local-moulding-material-review', configureServer: attach, configurePreviewServer: attach };
}
