import { useCallback, useEffect, useMemo, useState } from "react";
import { mouldings } from "../mouldings/catalog";
import type { BatchItem, ReviewResult } from "./OllamaMaterialReview";
import { MiniFramePreview } from "./MaterialReviewPreview";

type ModelInfo = { name: string; parameterSize?: string };
type RoutingPolicy = { primaryModel: string; fallbackModel: string; reason?: string; benchmarkId?: string };
type BenchmarkRun = BatchItem & {
  model: string;
  prompt: string;
  status: "queued" | "running" | "complete" | "failed";
  progress: number;
  message: string;
  durationMs?: number | null;
  result?: ReviewResult | null;
  humanDecision?: "accepted" | "rejected" | "pending";
};
type Benchmark = {
  id: string;
  status: "running" | "pausing" | "paused" | "complete";
  models: string[];
  prompt: string;
  current: number;
  total: number;
  message: string;
  runs: BenchmarkRun[];
  recommendation?: RoutingPolicy | null;
  createdAt: string;
};

const fixedBenchmarkPrompt = `PROFILE REVIEW
Use the exact SKU supplier photographs and stated dimensions to produce and apply a constrained reconstruction specification for the physical cross-section. Treat catalogue traces as unverified guides. Confirm every ridge, bead, bevel, hollow, step, outer edge, sight edge and rebate visually. Do not add a feature that is unsupported by the photographs.

TEXTURE AND COLOUR REVIEW
Produce and apply a constrained material specification matching the exact SKU colour, finish, gloss, directional grain or brushing, texture scale and surface relief. Family images show presentation character only and must never override exact-SKU colour or geometry. Remove obvious tiling and seams while retaining natural variation.

BENCHMARK RULES
This is a controlled comparison. Judge only the supplied evidence, return the required structured fields, and use the same standards for every moulding and model.`;

function representativeItems(items: BatchItem[], count: number) {
  const eligible = items.filter(item => item.eligible !== false).map(item => ({
    item,
    moulding: mouldings.find(candidate => candidate.sku === item.sku),
  })).filter(value => value.moulding && !value.moulding.discontinued &&
    value.moulding.supplierImages?.some(image => image.kind !== "family"));
  const groups = new Map<string, typeof eligible>();
  for (const value of eligible) {
    const moulding = value.moulding!;
    const key = `${moulding.supplier}|${moulding.profileType}|${moulding.colourTags?.[0] || moulding.finish.split(/\s+/)[0]}`;
    const group = groups.get(key) || [];
    group.push(value); groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => a[0].item.sku.localeCompare(b[0].item.sku));
  const result: BatchItem[] = [];
  let depth = 0;
  while (result.length < Math.min(count, eligible.length)) {
    let added = false;
    for (const group of orderedGroups) {
      if (group[depth]) { result.push(group[depth].item); added = true; }
      if (result.length >= count) break;
    }
    if (!added) break;
    depth += 1;
  }
  return result;
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function fmt(value: number | null, suffix = "") {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}${suffix}`;
}

export default function OllamaBenchmark({ models, items, busy, routingPolicy, onPolicyChanged }: {
  models: ModelInfo[];
  items: BatchItem[];
  busy: boolean;
  routingPolicy?: RoutingPolicy | null;
  onPolicyChanged: (policy: RoutingPolicy) => void;
}) {
  const [open, setOpen] = useState(false);
  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [suiteSize, setSuiteSize] = useState(12);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [selectedRun, setSelectedRun] = useState<BenchmarkRun | null>(null);
  const [error, setError] = useState("");
  const suite = useMemo(() => representativeItems(items, suiteSize), [items, suiteSize]);

  const apply = useCallback((next: Benchmark | null) => {
    setBenchmark(next);
    if (next) {
      localStorage.setItem("frame-visualiser:model-benchmark", next.id);
      setSelectedRun(current => {
        const matched = current && next.runs.find(run => run.sku === current.sku && run.model === current.model);
        return matched || next.runs[0] || null;
      });
    }
  }, []);

  useEffect(() => {
    setSelectedModels(current => current.length ? current.filter(name => models.some(model => model.name === name)) : models.map(model => model.name));
  }, [models]);

  useEffect(() => {
    const saved = localStorage.getItem("frame-visualiser:model-benchmark");
    fetch(`/api/material-review/benchmark${saved ? `?id=${encodeURIComponent(saved)}` : ""}`, { cache: "no-store" })
      .then(response => response.json()).then(data => { if (data.benchmark) apply(data.benchmark); })
      .catch(() => {});
  }, [apply]);

  useEffect(() => {
    if (!benchmark?.id || !["running", "pausing"].includes(benchmark.status)) return;
    const timer = window.setInterval(() => {
      fetch(`/api/material-review/benchmark?id=${encodeURIComponent(benchmark.id)}`, { cache: "no-store" })
        .then(response => response.json()).then(data => { if (data.benchmark) apply(data.benchmark); })
        .catch(() => setError("Benchmark status is temporarily unavailable; its saved results are safe."));
    }, 1400);
    return () => window.clearInterval(timer);
  }, [benchmark?.id, benchmark?.status, apply]);

  async function prepare() {
    setError("");
    try {
      const response = await fetch("/api/material-review/benchmark", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: selectedModels, prompt: fixedBenchmarkPrompt,
          items: suite.map(item => ({ ...item, prompt: fixedBenchmarkPrompt })) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not prepare the benchmark.");
      apply(data); setOpen(true);
    } catch (reason: any) { setError(reason.message || "Could not prepare the benchmark."); }
  }

  async function control(action: "pause" | "resume" | "adopt") {
    if (!benchmark) return;
    setError("");
    try {
      const response = await fetch(`/api/material-review/benchmark/${benchmark.id}/${action}`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Could not ${action} the benchmark.`);
      if (data.benchmark) apply(data.benchmark); else apply(data);
      if (data.routingPolicy) onPolicyChanged(data.routingPolicy);
    } catch (reason: any) { setError(reason.message || `Could not ${action} the benchmark.`); }
  }

  async function rate(run: BenchmarkRun, decision: "accepted" | "rejected") {
    if (!benchmark) return;
    setError("");
    try {
      const response = await fetch(`/api/material-review/benchmark/${benchmark.id}/rate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: run.sku, model: run.model, decision }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save the benchmark rating.");
      apply(data);
    } catch (reason: any) { setError(reason.message || "Could not save the benchmark rating."); }
  }

  function newBenchmark() {
    setBenchmark(null);
    setSelectedRun(null);
    setError("");
    localStorage.removeItem("frame-visualiser:model-benchmark");
  }

  const summaries = useMemo(() => (benchmark?.models || selectedModels).map(model => {
    const runs = (benchmark?.runs || []).filter(run => run.model === model && ["complete", "failed"].includes(run.status));
    const complete = runs.filter(run => run.status === "complete" && run.result);
    const rated = complete.filter(run => run.humanDecision === "accepted" || run.humanDecision === "rejected");
    return { model, finished: runs.length, completed: complete.length,
      passed: complete.filter(run => run.result?.status === "automated-approved-candidate").length,
      humanRated: rated.length, humanAccepted: rated.filter(run => run.humanDecision === "accepted").length,
      imageScore: mean(complete.map(run => Math.max(0, ...(run.result?.attempts || []).map(attempt => attempt.deterministicScore || 0)))),
      confidence: mean(complete.map(run => (run.result?.reviewer?.confidence || 0) * 100)),
      colour: mean(complete.map(run => Number(run.result?.bestMetrics?.colourDeltaE)).filter(Number.isFinite)),
      minutes: mean(complete.map(run => Number(run.durationMs) / 60000).filter(Number.isFinite)) };
  }), [benchmark, selectedModels]);

  const completedCount = benchmark?.runs.filter(run => ["complete", "failed"].includes(run.status)).length || 0;
  const activeRun = benchmark?.runs.find(run => run.status === "running") || null;
  const aggregateProgress = benchmark?.runs.reduce((sum, run) =>
    sum + (["complete", "failed"].includes(run.status) ? 100 : Math.max(0, run.progress || 0)), 0) || 0;
  const selectedMoulding = selectedRun ? mouldings.find(item => item.sku === selectedRun.sku) : null;

  return <div className="model-benchmark-launch">
    <label>Local model benchmark</label>
    <p className="review-note">Compare installed vision models on the same representative mouldings, evidence, prompt and automatic checks.</p>
    <button type="button" onClick={() => setOpen(true)} disabled={!models.length}>
      {benchmark ? `Open saved benchmark · ${benchmark.status}` : "Set up model benchmark"}
    </button>
    {routingPolicy && <small className="benchmark-policy">Tiered batches: {routingPolicy.primaryModel} → {routingPolicy.fallbackModel}</small>}
    {error && <p className="ollama-error" role="alert">{error}</p>}

    {open && <div className="batch-workspace benchmark-workspace" role="dialog" aria-modal="true" aria-label="Local model benchmark">
      <header><div><span>LOCAL MODEL LAB</span><h2>Supplier-grounded benchmark</h2>
        <p>{benchmark ? `${benchmark.models.length} models · ${benchmark.total} controlled runs` : "Prepare a saved, paused benchmark before running it"}</p></div>
        <div className="batch-workspace-actions">
          {benchmark?.status === "running" && <button type="button" onClick={() => void control("pause")}>Pause after current</button>}
          {benchmark?.status === "pausing" && <button type="button" disabled>Pausing…</button>}
          {benchmark?.status === "paused" && <button type="button" className="approve" onClick={() => void control("resume")}>{benchmark.current ? "Resume benchmark" : "Start benchmark"}</button>}
          {benchmark && !["running", "pausing"].includes(benchmark.status) && <button type="button" onClick={newBenchmark}>New benchmark</button>}
          <button type="button" onClick={() => setOpen(false)}>Close</button>
        </div></header>

      {!benchmark && <section className="benchmark-setup">
        <div><label>Installed vision models</label>{models.map(model => <label className="benchmark-model-option" key={model.name}>
          <input type="checkbox" checked={selectedModels.includes(model.name)} onChange={() => setSelectedModels(current =>
            current.includes(model.name) ? current.filter(name => name !== model.name) : [...current, model.name])} />
          <strong>{model.name}</strong><span>{model.parameterSize || "Local vision model"}</span>
        </label>)}</div>
        <div><label>Representative suite</label><div className="benchmark-size-options">{[12, 24, 48].map(size =>
          <button type="button" className={suiteSize === size ? "active" : ""} key={size} onClick={() => setSuiteSize(size)}>{size} mouldings</button>)}</div>
          <p>{suite.length} eligible frames selected across suppliers, profile shapes and colour families. This creates {suite.length * selectedModels.length} runs.</p>
          <button type="button" className="approve" disabled={busy || !selectedModels.length || !suite.length} onClick={() => void prepare()}>Prepare benchmark</button>
        </div>
        <details><summary>Fixed prompt used for every run</summary><pre>{fixedBenchmarkPrompt}</pre></details>
      </section>}

      {benchmark && <>
        <section className="batch-workspace-summary"><progress max={Math.max(1, benchmark.total * 100)} value={aggregateProgress} />
          <strong>{activeRun ? `${activeRun.model} · ${activeRun.sku} · ${activeRun.progress}%` : benchmark.message}</strong>
          {activeRun && <span>{activeRun.message}</span>}<span>{completedCount}/{benchmark.total} finished</span></section>
        <section className="benchmark-summary-grid">{summaries.map(summary => <article key={summary.model}>
          <strong>{summary.model}</strong><dl>
            <div><dt>Automatic passes</dt><dd>{summary.passed}/{summary.completed || 0}</dd></div>
            <div><dt>Your approvals</dt><dd>{summary.humanAccepted}/{summary.humanRated}</dd></div>
            <div><dt>Image score</dt><dd>{fmt(summary.imageScore, "/100")}</dd></div>
            <div><dt>Vision confidence</dt><dd>{fmt(summary.confidence, "%")}</dd></div>
            <div><dt>Colour ΔE</dt><dd>{fmt(summary.colour)}</dd></div>
            <div><dt>Average time</dt><dd>{fmt(summary.minutes, " min")}</dd></div>
          </dl></article>)}</section>
        {benchmark.recommendation && <section className="benchmark-recommendation"><div><label>Recommended tiered routing</label>
          <strong>{benchmark.recommendation.primaryModel} <span>primary</span> → {benchmark.recommendation.fallbackModel} <span>fallback</span></strong>
          <p>{benchmark.recommendation.reason}</p></div>
          <button type="button" className="approve" disabled={benchmark.status !== "complete"} onClick={() => void control("adopt")}>Use for future batches</button></section>}
        <div className="benchmark-results-layout"><section className="benchmark-run-list"><label>Every model run</label>
          {benchmark.runs.map((run, index) => <button type="button" key={`${run.sku}-${run.model}-${index}`}
            className={selectedRun?.sku === run.sku && selectedRun.model === run.model ? "active" : ""} onClick={() => setSelectedRun(run)}>
            <strong>{run.sku}</strong><span>{run.model}</span><em>{run.status}</em><progress max={100} value={run.progress || (run.status === "complete" ? 100 : 0)} />
          </button>)}</section>
          <aside className="benchmark-run-inspector">{selectedRun ? <>
            <span>{selectedRun.supplier} · {selectedRun.model}</span><h3>{selectedRun.sku} · {selectedRun.name}</h3>
            <div className="batch-preview-grid"><figure><figcaption>Before</figcaption><div className="batch-mini-viewer"><MiniFramePreview sku={selectedRun.sku} result={selectedRun.result} mode="before" /></div></figure>
              <figure><figcaption>After</figcaption><div className="batch-mini-viewer">{selectedRun.result ? <MiniFramePreview sku={selectedRun.sku} result={selectedRun.result} mode="after" /> : <div className="batch-preview-empty">Awaiting this model</div>}</div></figure></div>
            <dl className="batch-result-facts"><div><dt>Status</dt><dd>{selectedRun.result?.status || selectedRun.status}</dd></div>
              <div><dt>Time</dt><dd>{selectedRun.durationMs ? `${(selectedRun.durationMs / 60000).toFixed(1)} min` : "—"}</dd></div>
              <div><dt>Colour ΔE</dt><dd>{selectedRun.result?.bestMetrics?.colourDeltaE?.toFixed(2) || "—"}</dd></div>
              <div><dt>Decision</dt><dd>{selectedRun.result?.reviewer?.decision || "—"}</dd></div></dl>
            {!!selectedRun.result?.bestFailedGates?.length && <p className="batch-inspector-warning"><strong>Failed checks</strong>{selectedRun.result.bestFailedGates.join(", ")}</p>}
            {!!selectedRun.result?.reviewer?.reasons?.length && <p className="ollama-summary"><strong>Model findings</strong>{selectedRun.result.reviewer.reasons.join(" ")}</p>}
            {selectedRun.result?.correctionPlan && <details className="correction-plan"><summary>Model reconstruction plan</summary>
              <pre>{JSON.stringify(selectedRun.result.correctionPlan, null, 2)}</pre></details>}
            {selectedRun.result && <div className="review-actions decision-actions benchmark-rating">
              <button type="button" className={selectedRun.humanDecision === "accepted" ? "approve active" : "approve"} onClick={() => void rate(selectedRun, "accepted")}>Mark benchmark result good</button>
              <button type="button" className={selectedRun.humanDecision === "rejected" ? "active" : ""} onClick={() => void rate(selectedRun, "rejected")}>Mark result inaccurate</button>
            </div>}
            {selectedMoulding?.supplierImages?.length ? <details><summary>Evidence and fixed prompt</summary><div className="batch-evidence-thumbs">{selectedMoulding.supplierImages.map(image => <figure key={image.url}><img src={image.url} alt={image.label} /><figcaption>{image.label}</figcaption></figure>)}</div><pre>{selectedRun.prompt}</pre></details> : null}
          </> : <p>Select a run to inspect it.</p>}</aside></div>
      </>}
    </div>}
  </div>;
}
