import { useCallback, useEffect, useRef, useState } from "react";

type ReviewResult = {
  sku?: string;
  status: string;
  requestedFault?: string;
  inputVariant?: string;
  outputVariant: string;
  bestMetrics?: Record<string, number>;
  bestFailedGates?: string[];
  attempts?: Array<{
    attempt: number;
    deterministicScore?: number;
    agentScore?: number;
    failedGates?: string[];
    observations?: string[];
    blockers?: string[];
  }>;
  analyst?: { finishClass?: string; gloss?: string; risks?: string[] };
  reviewer?: { decision?: string; confidence?: number; reasons?: string[]; concerns?: string[] };
  model?: string;
  reviewScopes?: string[];
  profile?: {
    points?: Array<[number, number]>;
    shapeClass?: string;
    source?: string;
    reviewer?: { decision?: string; confidence?: number; reasons?: string[]; concerns?: string[] };
  };
  profileGate?: { passed?: boolean; requiresPhotoVerification?: boolean };
  revision: number;
  versionId?: string;
  createdAt?: string;
  decision?: string;
};
type Job = {
  id: string;
  sku: string;
  fault: string;
  model: string;
  scopes?: string[];
  status: "running" | "complete" | "failed";
  progress: number;
  message: string;
  events?: Array<{ progress: number; message: string; at: string }>;
  result?: ReviewResult | null;
};
type Availability = {
  available: boolean;
  busy: boolean;
  eligible: boolean;
  model?: string | null;
  models?: Array<{ name: string; size?: number; parameterSize?: string }>;
  error?: string | null;
  existing?: ReviewResult | null;
  history?: ReviewResult[];
  assetStatus?: string;
  acceptedVersion?: string | null;
};
type BatchItem = {
  sku: string;
  supplier: string;
  name: string;
  eligible?: boolean;
  scopes?: Array<"profile" | "material">;
};
type BatchResult = { sku: string; name: string; result: ReviewResult };
type BatchQueueItem = BatchItem & {
  prompt: string;
  status: "queued" | "running" | "complete" | "failed";
  progress: number;
  message: string;
  jobId?: string | null;
  result?: ReviewResult | null;
};
type BatchJob = {
  id: string;
  status: "running" | "pausing" | "paused" | "complete";
  model: string;
  prompt: string;
  current: number;
  total: number;
  message: string;
  items: BatchQueueItem[];
  createdAt: string;
  updatedAt: string;
};

const profilePrompt = `PROFILE REVIEW
Study the supplier cross-section and rotation photographs. Treat any extracted red outline or catalogue trace as an unverified guide, then confirm every ridge, bead, bevel, hollow and step independently in the supplier photographs. Photographs of the physical section, chevron and oblique rotations take priority when a trace conflicts with visible evidence. Rebuild the physical moulding cross-section, including the face, inner sight edge, outer edge, rebate and stated dimensions. A visibly flat moulding must remain one planar face with only genuinely visible edge treatment; omit profile features supported only by the extracted trace. Compare the rendered candidate with the supplier evidence and reject unsupported geometry.`;
const materialPrompt = `TEXTURE AND COLOUR REVIEW
Study all supplier photographs and match the finish, colour, directional grain or brushing, texture scale, gloss and surface relief. Remove obvious tiling and seams while retaining natural variation. Compare the candidate under neutral fixed lighting with the supplier evidence.`;

function removePromptBlock(value: string, block: string) {
  return value.replace(block, "").replace(/\n{3,}/g, "\n\n").trim();
}

function queuedPrompt(value: string, scopes: string[]) {
  const custom = removePromptBlock(removePromptBlock(value, profilePrompt), materialPrompt);
  return [
    custom,
    scopes.includes("profile") ? profilePrompt : "",
    scopes.includes("material") ? materialPrompt : "",
  ].filter(Boolean).join("\n\n");
}

const savedJobKey = "frame-visualiser:material-review-job";
const savedBatchKey = "frame-visualiser:material-review-batch";

export default function OllamaMaterialReview({
  sku,
  name,
  onUseCandidate,
  onUseBaseline,
  batchItems,
  selectedBatchItems,
  onClearSelectedBatch,
  assetStatuses,
  onStatusesChanged,
}: {
  sku: string;
  name: string;
  onUseCandidate: (result: ReviewResult, targetSku?: string) => void;
  onUseBaseline: (variant: string, targetSku?: string) => void;
  batchItems: BatchItem[];
  selectedBatchItems: BatchItem[];
  onClearSelectedBatch: () => void;
  assetStatuses: Record<string, { assetStatus: string }>;
  onStatusesChanged: () => void;
}) {
  const [fault, setFault] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [error, setError] = useState("");
  const [compareMode, setCompareMode] = useState<"before" | "after">("after");
  const [batchSupplier, setBatchSupplier] = useState("All");
  const [batch, setBatch] = useState<BatchJob | null>(null);
  const [batchWorkspace, setBatchWorkspace] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [comparisonSku, setComparisonSku] = useState(sku);
  const completed = useRef<string | null>(null);
  const completedBatch = useRef<string | null>(null);
  const selectedBatchKey = selectedBatchItems
    .map(item => `${item.sku}:${(item.scopes || []).join("+")}`)
    .sort().join("|");

  const applyBatch = useCallback((next: BatchJob | null) => {
    setBatch(next);
    if (next) {
      localStorage.setItem(savedBatchKey, next.id);
      setBatchResults(next.items.filter(item => item.result).map(item => ({
        sku: item.sku, name: item.name, result: { ...item.result!, sku: item.sku },
      })));
    }
  }, []);

  const check = useCallback(async () => {
    try {
      const response = await fetch(`/api/material-review?sku=${encodeURIComponent(sku)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not contact the material reviewer.");
      setAvailability(data);
      setModelChoice(current => current && data.models?.some((item: any) => item.name === current)
        ? current : data.model || data.models?.[0]?.name || "");
      setError("");
    } catch (reason: any) {
      setAvailability(null);
      setError(reason.message || "Could not contact the material reviewer.");
    }
  }, [sku]);

  useEffect(() => {
    void check();
    try {
      const stored = JSON.parse(sessionStorage.getItem(savedJobKey) || "null");
      if (stored?.id && stored?.sku === sku) {
        setJob(stored);
        if (stored.fault) setFault(stored.fault);
        if (stored.model) setModelChoice(stored.model);
        if (stored.scopes?.length) setScopes(stored.scopes);
      }
      else setJob(null);
    } catch { setJob(null); }
  }, [sku, check]);

  useEffect(() => {
    const saved = localStorage.getItem(savedBatchKey);
    const restoreBatch = async () => {
      try {
        let response = await fetch(`/api/material-review/batch${saved ? `?id=${encodeURIComponent(saved)}` : ""}`, { cache: "no-store" });
        let data = await response.json();
        if (!data.batch && saved) {
          localStorage.removeItem(savedBatchKey);
          response = await fetch("/api/material-review/batch", { cache: "no-store" });
          data = await response.json();
        }
        if (data.batch) applyBatch(data.batch);
      } catch {
        // The status poll will recover when the local server is available again.
      }
    };
    void restoreBatch();
  }, [applyBatch]);

  useEffect(() => {
    if (!batch?.id || !["running", "pausing"].includes(batch.status)) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/material-review/batch?id=${encodeURIComponent(batch.id)}`, {
          cache: "no-store", signal: controller.signal,
        });
        const data = await response.json();
        if (response.ok && data.batch) applyBatch(data.batch);
      } catch (reason: any) {
        if (reason.name !== "AbortError") setError("Batch status is temporarily unavailable. The saved queue is safe on disk.");
      }
    };
    const timer = window.setInterval(() => void poll(), 1400);
    void poll();
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [batch?.id, batch?.status, applyBatch]);

  useEffect(() => {
    if (batch?.status !== "complete" || completedBatch.current === batch.id) return;
    completedBatch.current = batch.id;
    onStatusesChanged(); void check();
  }, [batch?.id, batch?.status, onStatusesChanged, check]);

  useEffect(() => {
    if (!selectedBatchItems.length || batch?.id) {
      if (!selectedBatchItems.length) setBatchResults([]);
      return;
    }
    const controller = new AbortController();
    Promise.all(selectedBatchItems.map(async item => {
      const response = await fetch(`/api/material-review?sku=${encodeURIComponent(item.sku)}`, {
        cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) return null;
      const data = await response.json();
      const latest = data.history?.[0] || data.existing;
      return latest ? { sku: item.sku, name: item.name, result: { ...latest, sku: item.sku } } : null;
    })).then(items => setBatchResults(items.filter(Boolean) as BatchResult[])).catch(reason => {
      if (reason.name !== "AbortError") setError(reason.message || "Could not load batch results.");
    });
    return () => controller.abort();
  }, [selectedBatchKey, batch?.id]);

  useEffect(() => {
    if (!job) return;
    sessionStorage.setItem(savedJobKey, JSON.stringify(job));
    if (job.status !== "running") return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/material-review/${job.id}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Review status is unavailable.");
        setJob(data);
        setError("");
      } catch (reason: any) {
        if (reason.name !== "AbortError") setError(`${reason.message || "Connection lost."} Retrying…`);
      }
    };
    const timer = window.setInterval(() => void poll(), 1500);
    void poll();
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (job?.status !== "complete" || !job.result || completed.current === job.id) return;
    completed.current = job.id;
    onUseCandidate(job.result);
    setCompareMode("after");
    void check();
  }, [job, onUseCandidate, check]);

  async function start() {
    setError("");
    try {
      const response = await fetch("/api/material-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku, fault, model: modelChoice, scopes }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not start the material review.");
      completed.current = null;
      setJob(data);
    } catch (reason: any) {
      setError(reason.message || "Could not start the material review.");
      void check();
    }
  }

  async function decide(result: ReviewResult, decision: "accepted" | "rejected") {
    const targetSku = result.sku || sku;
    const response = await fetch("/api/material-review/decision", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: targetSku, versionId: result.versionId || result.outputVariant, decision }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setError(data.error || "Could not save the decision.");
    if (decision === "accepted") { onUseCandidate(result, targetSku); setCompareMode("after"); }
    else { onUseBaseline(result.inputVariant || "supplier-derived-v2", targetSku); setCompareMode("before"); }
    setComparisonSku(targetSku);
    setBatchResults(current => current.map(item => item.sku === targetSku
      ? { ...item, result: { ...item.result, decision } } : item));
    await check();
  }

  function showBefore(result: ReviewResult) {
    const targetSku = result.sku || sku;
    onUseBaseline(result.inputVariant || "supplier-derived-v2", targetSku);
    setCompareMode("before");
    setComparisonSku(targetSku);
  }

  function showAfter(result: ReviewResult) {
    const targetSku = result.sku || sku;
    onUseCandidate(result, targetSku);
    setCompareMode("after");
    setComparisonSku(targetSku);
  }

  async function runBatch(supplier?: string, selectedItems?: BatchItem[]) {
    const selectedQueue = Array.isArray(selectedItems);
    const automaticScopes = scopes.length ? scopes : ["profile", "material"];
    const queue = selectedQueue
      ? selectedItems.filter(item => item.eligible !== false && item.scopes?.length)
      : batchItems.filter(item => item.eligible !== false &&
          (!supplier || supplier === "All" || item.supplier === supplier) &&
          assetStatuses[item.sku]?.assetStatus !== "accepted");
    if (!queue.length) return setError(selectedQueue
      ? "No selected mouldings are ready for processing."
      : "No matching non-accepted mouldings are ready for processing.");
    setError("");
    const items = queue.map(item => {
      const itemScopes = item.scopes?.length ? item.scopes : automaticScopes;
      return { ...item, scopes: itemScopes, prompt: queuedPrompt(fault, itemScopes) };
    });
    const uniquePrompts = [...new Set(items.map(item => item.prompt))];
    const batchPrompt = uniquePrompts.length === 1
      ? uniquePrompts[0]
      : "This queue uses per-frame prompts. Open each frame below to see the exact Profile and/or Texture & colour instruction.";
    try {
      const response = await fetch("/api/material-review/batch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelChoice, prompt: batchPrompt, items }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not start the saved batch.");
      applyBatch(data); setBatchWorkspace(true);
    } catch (reason: any) { setError(reason.message || "Could not start the saved batch."); }
  }

  async function controlBatch(action: "pause" | "resume") {
    if (!batch) return;
    try {
      const response = await fetch(`/api/material-review/batch/${batch.id}/${action}`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Could not ${action} the batch.`);
      applyBatch(data);
    } catch (reason: any) { setError(reason.message || `Could not ${action} the batch.`); }
  }

  const batchRunning = batch?.status === "running" || batch?.status === "pausing";
  const busy = job?.status === "running" || batchRunning;
  const batchCompleted = batch?.items.filter(item => item.status === "complete").length || 0;
  const batchFailed = batch?.items.filter(item => item.status === "failed").length || 0;
  const batchPassed = batch?.items.filter(item => item.result?.status === "automated-approved-candidate").length || 0;
  const batchNeedsInspection = Math.max(0, batchCompleted - batchPassed);
  const batchResumable = batch?.status === "paused";
  const result = job?.result || availability?.existing || null;
  const model = job?.model || availability?.model || result?.model;
  const reviewer = result?.reviewer;
  const automaticBatchCount = batchItems.filter(item => item.eligible !== false &&
    assetStatuses[item.sku]?.assetStatus !== "accepted").length;
  const supplierBatchCount = batchItems.filter(item => item.eligible !== false &&
    (batchSupplier === "All" || item.supplier === batchSupplier) &&
    assetStatuses[item.sku]?.assetStatus !== "accepted").length;
  const toggleScope = (scope: "profile" | "material", prompt: string) => {
    if (scopes.includes(scope)) {
      setScopes(current => current.filter(value => value !== scope));
      setFault(current => removePromptBlock(current, prompt));
    } else {
      setScopes(current => [...current, scope]);
      setFault(current => [current.trim(), prompt].filter(Boolean).join("\n\n"));
    }
  };
  return (
    <div className="group ollama-review">
      <label>Ollama material review</label>
      <div className="ollama-selected">
        <span>Selected frame</span>
        <strong>{sku} · {name}</strong>
        <small>{model ? `Vision model: ${model}` : "Checking local vision models…"}</small>
      </div>
      <label htmlFor="moulding-review-model">Vision model</label>
      <select id="moulding-review-model" value={modelChoice}
        onChange={(event) => setModelChoice(event.target.value)} disabled={busy}>
        {(availability?.models || []).map(item => <option key={item.name} value={item.name}>
          {item.name}{item.parameterSize ? ` · ${item.parameterSize}` : ""}
        </option>)}
      </select>
      <small className="review-help">Only installed Ollama models with image capability are listed. The selected model sees the supplier references and generated comparison boards.</small>
      <label htmlFor="moulding-fault">Describe the visible fault</label>
      <div className="review-prompt-builders">
        <button type="button" aria-pressed={scopes.includes("profile")} className={scopes.includes("profile") ? "active" : ""} disabled={busy}
          onClick={() => toggleScope("profile", profilePrompt)}>{scopes.includes("profile") ? "✓ Profile" : "+ Profile"}</button>
        <button type="button" aria-pressed={scopes.includes("material")} className={scopes.includes("material") ? "active" : ""} disabled={busy}
          onClick={() => toggleScope("material", materialPrompt)}>{scopes.includes("material") ? "✓ Texture & colour" : "+ Texture & colour"}</button>
      </div>
      <textarea
        id="moulding-fault"
        value={fault}
        onChange={(event) => setFault(event.target.value)}
        disabled={busy}
        rows={4}
        maxLength={4000}
        placeholder="Example: The wood grain repeats every few centimetres and the finish is too orange compared with the supplier images."
      />
      <button type="button" className="ollama-run" onClick={start}
        disabled={busy || fault.trim().length < 4 || scopes.length === 0 || !modelChoice || availability?.available === false || availability?.eligible === false}>
        {busy ? "Ollama is reviewing this moulding…" : "Review and fix selected frame"}
      </button>
      {availability?.eligible === false && <p className="review-note">This frame has no usable local material image yet.</p>}
      {scopes.length === 0 && <p className="review-note">Add Profile, Texture &amp; colour, or both to build the editable review prompt.</p>}
      {availability?.available === false && <p className="review-note">{availability.error || "Start Ollama and the local visualiser server, then try again."}</p>}
      {job?.status === "running" && <div className="ollama-progress" role="status" aria-live="polite">
        <div><span>{job.progress}%</span><strong>{job.message}</strong></div>
        <progress max={100} value={Math.max(1, job.progress)} />
        {!!job.events?.length && <ol>{job.events.slice(-4).map((event, index) =>
          <li key={`${event.at}-${index}`}>{event.message}</li>)}</ol>}
      </div>}
      {error && <p className="ollama-error" role="alert">{error}</p>}
      {job?.status === "failed" && <p className="ollama-error" role="alert">{job.message}</p>}
      {result && <div className="ollama-result" role="status">
        <div className={`review-state ${result.status === "automated-approved-candidate" ? "approved" : "tuning"}`}>
          {result.status === "automated-approved-candidate" ? "Ollama candidate passed" : "Candidate needs inspection"}
        </div>
        <dl>
          <div><dt>Model</dt><dd>{result.model || model || "Deterministic checks"}</dd></div>
          <div><dt>Reviewed</dt><dd>{result.reviewScopes?.join(" + ") || "material"}</dd></div>
          <div><dt>Attempts</dt><dd>{result.attempts?.length || 0}</dd></div>
          <div><dt>Finish</dt><dd>{result.analyst?.finishClass || "Unclassified"}{result.analyst?.gloss ? ` · ${result.analyst.gloss}` : ""}</dd></div>
          <div><dt>Final review</dt><dd>{reviewer?.decision || result.status}{typeof reviewer?.confidence === "number" ? ` · ${Math.round(reviewer.confidence * 100)}%` : ""}</dd></div>
        </dl>
        {!!result.attempts?.length && <div className="ollama-attempts">
          {result.attempts.map(attempt => <div key={attempt.attempt}>
            <strong>Attempt {attempt.attempt}</strong>
            <span>Image checks {Math.round(attempt.deterministicScore || 0)}/100{attempt.agentScore ? ` · Ollama ${attempt.agentScore}/100` : ""}</span>
            {!!attempt.observations?.length && <p>{attempt.observations.join(" ")}</p>}
            {!!attempt.failedGates?.length && <small>Held by: {attempt.failedGates.join(", ")}</small>}
          </div>)}
        </div>}
        {!!reviewer?.reasons?.length && <p className="ollama-summary"><strong>What Ollama found</strong>{reviewer.reasons.join(" ")}</p>}
        {!!reviewer?.concerns?.length && <p className="ollama-summary"><strong>Remaining concerns</strong>{reviewer.concerns.join(" ")}</p>}
        {result.profile && <p className="ollama-summary"><strong>Profile result</strong>
          {result.profile.shapeClass || "Candidate cross-section"} · {result.profile.points?.length || 0} controlled points.
          {result.profileGate?.requiresPhotoVerification
            ? ` Photographic verification: ${result.profileGate.passed ? "passed" : "held for review"}.`
            : ""}
          {result.profile.reviewer?.reasons?.join(" ") || " The candidate was generated from supplier dimensions and visual references."}</p>}
        <div className="before-after-switch" aria-label="Before and after comparison">
          <button type="button" className={compareMode === "before" && comparisonSku === (result.sku || sku) ? "active" : ""} onClick={() => showBefore(result)}>Before</button>
          <button type="button" className={compareMode === "after" && comparisonSku === (result.sku || sku) ? "active" : ""} onClick={() => showAfter(result)}>After</button>
        </div>
        <p className="review-note">The frame at left shows the selected comparison. Before uses {result.inputVariant || "the previous supplier version"}; After uses this saved candidate.</p>
        <div className="review-actions decision-actions">
          <button type="button" className="approve" onClick={() => void decide(result, "accepted")}>Accept this version</button>
          <button type="button" onClick={() => void decide(result, "rejected")}>Reject changes</button>
        </div>
      </div>}
      {!!availability?.history?.length && <div className="review-history">
        <label>Version history</label>
        <p className="review-note">Every completed candidate is retained. Choosing a version changes the preview but does not clear the history.</p>
        {availability.history.map(version => <div className={`history-row ${version.decision || "pending"}`} key={version.versionId}>
          <button type="button" onClick={() => showAfter(version)}>
            <strong>{version.versionId === availability.acceptedVersion ? "Kept version" : version.decision === "rejected" ? "Rejected" : "Candidate"}</strong>
            <span>{version.model || "Local checks"} · {version.createdAt ? new Date(version.createdAt).toLocaleString() : version.versionId}</span>
          </button>
          <div>
            <button type="button" onClick={() => void decide(version, "accepted")}>Keep</button>
            <button type="button" onClick={() => void decide(version, "rejected")}>Reject</button>
          </div>
        </div>)}
      </div>}
      <div className="batch-review">
        <label>Batch processing</label>
        <p className="review-note">The queue is saved on this computer. You can close the page, reopen the laptop, then resume from the first unfinished moulding. Pause takes effect after the current moulding completes safely.</p>
        {batch && <button type="button" className="batch-workspace-open" onClick={() => setBatchWorkspace(true)}>
          Open batch workspace · {batch.status}
        </button>}
        {!!selectedBatchItems.length && <div className="selected-batch-summary">
          <div><strong>Grid selection · {selectedBatchItems.length}</strong>
            <button type="button" onClick={onClearSelectedBatch} disabled={busy}>Clear selection</button></div>
          <ul>{selectedBatchItems.map(item => <li key={item.sku}>
            <span>{item.sku}</span><small>{item.scopes?.map(scope => scope === "material" ? "Texture" : "Profile").join(" + ")}</small>
            <em className={assetStatuses[item.sku]?.assetStatus || "pending"}>{assetStatuses[item.sku]?.assetStatus === "accepted" ? "OK" : assetStatuses[item.sku]?.assetStatus === "needs-work" ? "Not OK" : "Pending"}</em>
          </li>)}</ul>
          <button type="button" className="process-selected-batch"
            disabled={busy || batchResumable || !modelChoice || !selectedBatchItems.some(item => item.eligible !== false && item.scopes?.length)}
            onClick={() => void runBatch(undefined, selectedBatchItems)}>Process selected queue</button>
          <p className="review-note">The selected queue includes accepted mouldings. Each item uses its Profile and Texture choices from the grid.</p>
        </div>}
        <select aria-label="Batch supplier" value={batchSupplier} onChange={event => setBatchSupplier(event.target.value)} disabled={busy}>
          <option>All</option>{[...new Set(batchItems.map(item => item.supplier))].map(value => <option key={value}>{value}</option>)}
        </select>
        <div className="batch-actions">
          <button type="button" disabled={busy || batchResumable || !modelChoice || availability?.available === false}
            onClick={() => void runBatch()}>Process all non-accepted ({automaticBatchCount})</button>
          <button type="button" disabled={busy || batchResumable || !modelChoice || availability?.available === false}
            onClick={() => void runBatch(batchSupplier)}>Process supplier queue ({supplierBatchCount})</button>
        </div>
        <p className="review-note">
          {scopes.length
            ? `Automatic batches use the selected ${scopes.map(scope => scope === "material" ? "Texture & colour" : "Profile").join(" + ")} review and the editable prompt above.`
            : "Automatic batches default to a full Profile + Texture & colour review. Select either review type above to limit the batch."}
        </p>
        {availability?.available === false && <p className="ollama-error" role="alert">
          {availability.error || "Start Ollama before running a batch."}
        </p>}
        {batch && <div className="batch-progress" role="status">
          <progress max={Math.max(1, batch.total)} value={batchCompleted + batchFailed} />
          <strong>{batch.message}</strong>
          {!!batch.total && <span>{batchCompleted + batchFailed}/{batch.total} finished · {batchPassed} passed · {batchNeedsInspection} inspect · {batchFailed} failed</span>}
          <div className="batch-control-actions">
            {batchRunning && <button type="button" onClick={() => void controlBatch("pause")} disabled={batch.status === "pausing"}>
              {batch.status === "pausing" ? "Pausing…" : "Pause after current"}
            </button>}
            {batch.status === "paused" && <button type="button" className="approve" onClick={() => void controlBatch("resume")}>Resume batch</button>}
            <button type="button" onClick={() => setBatchWorkspace(true)}>Full workspace</button>
          </div>
        </div>}
        {!!batchResults.length && <div className="batch-result-list">
          <label>Review batch results</label>
          <p className="review-note">Choose Before or After to load that moulding and result in the viewer.</p>
          {batchResults.map(item => <article key={`${item.sku}-${item.result.versionId || item.result.outputVariant}`}>
            <div><strong>{item.sku}</strong><span>{item.name}</span>
              <em className={item.result.status === "automated-approved-candidate" ? "approved" : "tuning"}>
                {item.result.status === "automated-approved-candidate" ? "Passed" : "Inspect"}
              </em></div>
            <div className="before-after-switch">
              <button type="button" className={comparisonSku === item.sku && compareMode === "before" ? "active" : ""}
                onClick={() => showBefore(item.result)}>Before</button>
              <button type="button" className={comparisonSku === item.sku && compareMode === "after" ? "active" : ""}
                onClick={() => showAfter(item.result)}>After</button>
            </div>
            <div className="review-actions decision-actions">
              <button type="button" className="approve" onClick={() => void decide(item.result, "accepted")}>Accept</button>
              <button type="button" onClick={() => void decide(item.result, "rejected")}>Reject</button>
            </div>
          </article>)}
        </div>}
      </div>
      {batchWorkspace && batch && <div className="batch-workspace" role="dialog" aria-modal="true" aria-label="Batch processing workspace">
        <header>
          <div><span>Ollama batch</span><h2>{batch.status === "complete" ? "Batch complete" : "Saved processing queue"}</h2>
            <p>{batch.model} · started {new Date(batch.createdAt).toLocaleString()}</p></div>
          <div className="batch-workspace-actions">
            {batchRunning && <button type="button" onClick={() => void controlBatch("pause")} disabled={batch.status === "pausing"}>{batch.status === "pausing" ? "Pausing…" : "Pause after current"}</button>}
            {batch.status === "paused" && <button type="button" className="approve" onClick={() => void controlBatch("resume")}>Resume</button>}
            <button type="button" onClick={() => setBatchWorkspace(false)}>Close</button>
          </div>
        </header>
        <section className="batch-workspace-summary">
          <progress max={Math.max(1, batch.total)} value={batchCompleted + batchFailed} />
          <strong>{batch.message}</strong>
          <span>{batchCompleted + batchFailed}/{batch.total} finished</span><span>{batchPassed} passed</span>
          <span>{batchNeedsInspection} need inspection</span><span>{batchFailed} failed</span>
        </section>
        <div className="batch-workspace-columns">
          <section className="batch-prompt-panel">
            <label>Prompt used for this batch</label>
            <textarea readOnly value={batch.prompt || "Each frame uses its selected Profile and/or Texture & colour prompt shown in the queue."} />
            <p>The exact per-frame prompt and review scope are retained with every queue item.</p>
          </section>
          <section className="batch-queue-panel">
            <label>Frames in this batch</label>
            <div className="batch-queue-list">{batch.items.map((item, index) => <article className={item.status} key={`${item.sku}-${index}`}>
              <div className="batch-item-heading"><strong>{index + 1}. {item.sku}</strong><span>{item.name}</span><em>{item.status === "complete" ? item.result?.status === "automated-approved-candidate" ? "Passed" : "Inspect" : item.status}</em></div>
              <progress max={100} value={item.progress || (item.status === "complete" ? 100 : 0)} />
              <small>{item.message}</small>
              <details><summary>Prompt and scope</summary><p>{(item.scopes || []).map(scope => scope === "material" ? "Texture & colour" : "Profile").join(" + ")}</p><pre>{item.prompt}</pre></details>
              {item.result && <details><summary>Review outcome</summary>
                {!!item.result.bestFailedGates?.length && <p>Image checks: {item.result.bestFailedGates.join(", ")}</p>}
                {!!item.result.reviewer?.reasons?.length && <ul>{item.result.reviewer.reasons.map((reason, reasonIndex) => <li key={`reason-${reasonIndex}`}>{reason}</li>)}</ul>}
                {!!item.result.reviewer?.concerns?.length && <ul>{item.result.reviewer.concerns.map((concern, concernIndex) => <li key={`concern-${concernIndex}`}>{concern}</li>)}</ul>}
              </details>}
              {item.result && <div className="batch-item-review">
                <button type="button" onClick={() => { showBefore({ ...item.result!, sku: item.sku }); setBatchWorkspace(false); }}>View before</button>
                <button type="button" onClick={() => { showAfter({ ...item.result!, sku: item.sku }); setBatchWorkspace(false); }}>View after</button>
                <button type="button" className="approve" onClick={() => void decide({ ...item.result!, sku: item.sku }, "accepted")}>Accept</button>
                <button type="button" onClick={() => void decide({ ...item.result!, sku: item.sku }, "rejected")}>Reject</button>
              </div>}
            </article>)}</div>
          </section>
        </div>
      </div>}
    </div>
  );
}
