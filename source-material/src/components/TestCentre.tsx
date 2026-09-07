import { useMemo, useRef, useState } from "react";

type TestStatus = "idle" | "running" | "passed" | "failed";
type CheckResult = {
  name: string;
  passed: boolean;
  detail: string;
};
type TestResult = {
  id: string;
  name: string;
  room: string;
  status: Exclude<TestStatus, "idle" | "running">;
  durationMs: number;
  checks: CheckResult[];
  runAt: string;
  previousStatus?: "passed" | "failed";
};
type Scenario = {
  id: string;
  name: string;
  description: string;
  pack: "admin" | "rooms" | "mouldings";
  room: string;
  url: string;
  width: number;
  height: number;
  inspect: "admin-live-viewer" | "wall-viewer" | "frame-detail" | "mount-camera-stability";
};

const scenarios: Scenario[] = [
  {
    id: "admin-live-panelled-desktop",
    name: "Admin live viewer · desktop",
    description: "Checks the lower Three.js preview for clipping, overflow and useful size.",
    pack: "admin",
    room: "panelled-white-salon",
    url: "/room-calibrator/?room=panelled-white-salon",
    width: 1440,
    height: 1000,
    inspect: "admin-live-viewer",
  },
  {
    id: "admin-live-panelled-compact",
    name: "Admin live viewer · compact",
    description: "Catches the narrow embedded-view regression at the minimum supported width.",
    pack: "admin",
    room: "panelled-white-salon",
    url: "/room-calibrator/?room=panelled-white-salon",
    width: 1100,
    height: 820,
    inspect: "admin-live-viewer",
  },
  {
    id: "room-neutral",
    name: "Neutral Gallery Wall",
    description: "Checks that the calibrated room, frame and artwork render together.",
    pack: "rooms",
    room: "neutral-gallery-wall",
    url: "/?mode=wall&room=neutral-gallery-wall&embed=1",
    width: 1280,
    height: 800,
    inspect: "wall-viewer",
  },
  {
    id: "room-stock-pilot",
    name: "Calibrated Test Room",
    description: "Scale sentinel using the room's strong architectural references.",
    pack: "rooms",
    room: "stock-pilot",
    url: "/?mode=wall&room=stock-pilot&embed=1",
    width: 1280,
    height: 800,
    inspect: "wall-viewer",
  },
  {
    id: "room-oblique",
    name: "Oblique Gallery Wall",
    description: "Perspective sentinel for a strongly angled wall.",
    pack: "rooms",
    room: "oblique-gallery-wall",
    url: "/?mode=wall&room=oblique-gallery-wall&embed=1",
    width: 1280,
    height: 800,
    inspect: "wall-viewer",
  },
  {
    id: "frame-detail",
    name: "Frame Detail render",
    description: "Checks that geometry, texture and artwork render in the inspection view.",
    pack: "mouldings",
    room: "n/a",
    url: "/?mode=inspect&embed=1",
    width: 1280,
    height: 800,
    inspect: "frame-detail",
  },
  {
    id: "outer-mount-camera",
    name: "Frame changes preserve camera",
    description: "Checks that changing the top mount or moulding does not reset an adjusted inspection camera.",
    pack: "mouldings",
    room: "n/a",
    url: "/?mode=inspect",
    width: 1280,
    height: 800,
    inspect: "mount-camera-stability",
  },
];

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const historyKey = "frame-visualiser:test-centre-history:v1";

function check(name: string, passed: boolean, detail: string): CheckResult {
  return { name, passed, detail };
}

export default function TestCentre() {
  const [selected, setSelected] = useState(() => new Set(scenarios.map((item) => item.id)));
  const [status, setStatus] = useState<TestStatus>("idle");
  const [results, setResults] = useState<TestResult[]>([]);
  const [history, setHistory] = useState<TestResult[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(historyKey) || "[]");
    } catch {
      return [];
    }
  });
  const [activeScenario, setActiveScenario] = useState<Scenario | null>(null);
  const [progress, setProgress] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const historyRef = useRef(history);

  const selectedCount = selected.size;
  const totals = useMemo(() => ({
    passed: results.filter((item) => item.status === "passed").length,
    failed: results.filter((item) => item.status === "failed").length,
  }), [results]);

  function recordHistory(result: TestResult) {
    const previous = historyRef.current.find((item) => item.id === result.id) ||
      results.find((item) => item.id === result.id);
    const recorded = { ...result, previousStatus: previous?.status };
    const next = [recorded, ...historyRef.current].slice(0, 80);
    historyRef.current = next;
    setHistory(next);
    localStorage.setItem(historyKey, JSON.stringify(next));
    return recorded;
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectPack(pack: Scenario["pack"]) {
    setSelected(new Set(scenarios.filter((item) => item.pack === pack).map((item) => item.id)));
  }

  async function loadScenario(scenario: Scenario) {
    setActiveScenario(scenario);
    await wait(50);
    const frame = iframeRef.current;
    if (!frame) throw new Error("The test viewport was not created.");
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Page load timed out.")), 15000);
      frame.onload = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      frame.src = `${scenario.url}${scenario.url.includes("?") ? "&" : "?"}qa=${Date.now()}`;
    });
    await wait(2400);
    return frame;
  }

  async function inspectScenario(scenario: Scenario, frame: HTMLIFrameElement): Promise<CheckResult[]> {
    const doc = frame.contentDocument;
    if (!doc) return [check("Same-origin document", false, "The test page could not be inspected.")];
    const body = doc.body;
    const canvas = doc.querySelector("canvas");
    const checks: CheckResult[] = [
      check("Page rendered", body.children.length > 0, `${body.children.length} top-level element(s)`),
      check("No horizontal page overflow", doc.documentElement.scrollWidth <= doc.documentElement.clientWidth + 2,
        `${doc.documentElement.scrollWidth}px content / ${doc.documentElement.clientWidth}px viewport`),
    ];

    if (scenario.inspect === "admin-live-viewer") {
      const live = doc.querySelector<HTMLElement>(".cal-live-viewer");
      const embedded = doc.querySelector<HTMLIFrameElement>(".cal-live-viewer iframe");
      checks.push(check("Live viewer exists", Boolean(live && embedded), live ? "Component found" : "Component missing"));
      if (live && embedded) {
        const rect = embedded.getBoundingClientRect();
        const nestedDoc = embedded.contentDocument;
        checks.push(check("Live viewer has useful width", rect.width >= 560, `${Math.round(rect.width)}px wide`));
        checks.push(check("Live viewer uses landscape ratio", rect.width / Math.max(rect.height, 1) >= 1.45,
          `${(rect.width / Math.max(rect.height, 1)).toFixed(2)}:1`));
        checks.push(check("Embedded viewer is not clipped", embedded.scrollWidth <= embedded.clientWidth + 2,
          `${embedded.scrollWidth}px content / ${embedded.clientWidth}px viewport`));
        if (nestedDoc) {
          checks.push(check("Embedded page has no horizontal overflow",
            nestedDoc.documentElement.scrollWidth <= nestedDoc.documentElement.clientWidth + 2,
            `${nestedDoc.documentElement.scrollWidth}px content / ${nestedDoc.documentElement.clientWidth}px viewport`));
          checks.push(check("Three.js canvas loaded", Boolean(nestedDoc.querySelector("canvas")),
            nestedDoc.querySelector("canvas") ? "Canvas present" : "Canvas missing"));
          const nestedPanel = nestedDoc.querySelector<HTMLElement>(".panel");
          const panelHidden = !nestedPanel || nestedDoc.defaultView?.getComputedStyle(nestedPanel).display === "none";
          checks.push(check("Embedded controls are hidden", panelHidden,
            panelHidden ? "Stage-only view" : "Viewer panel is visible"));
        }
      }
    } else {
      const stage = doc.querySelector<HTMLElement>(".stage");
      checks.push(check("Three.js canvas loaded", Boolean(canvas), canvas ? "Canvas present" : "Canvas missing"));
      const expectedStageWidth = scenario.inspect === "mount-camera-stability"
        ? frame.clientWidth * 0.65
        : frame.clientWidth - 4;
      checks.push(check("Render stage has expected width", Boolean(stage && stage.clientWidth >= expectedStageWidth),
        stage ? `${stage.clientWidth} × ${stage.clientHeight}px` : "Stage missing"));
      if (scenario.inspect === "mount-camera-stability") {
        const before = canvas?.dataset.cameraPose;
        const mountButton = Array.from(doc.querySelectorAll<HTMLButtonElement>("button"))
          .find((button) => button.textContent?.trim() === "70 mm");
        mountButton?.click();
        await wait(500);
        const after = canvas?.dataset.cameraPose;
        checks.push(check("Outer mount control found", Boolean(mountButton),
          mountButton ? "70 mm mount option found" : "70 mm mount option missing"));
        checks.push(check("Outer mount preserves camera pose", Boolean(before && after && before === after),
          before && after ? `${before} → ${after}` : "Camera pose was unavailable"));

        const mouldingSelect = Array.from(doc.querySelectorAll<HTMLSelectElement>("select"))
          .find((select) => Array.from(select.options)
            .some((option) => option.textContent?.includes("POL-4875")));
        const alternative = mouldingSelect
          ? Array.from(mouldingSelect.options).find((option) => option.value !== mouldingSelect.value)
          : undefined;
        const beforeMoulding = canvas?.dataset.cameraPose;
        if (mouldingSelect && alternative) {
          mouldingSelect.value = alternative.value;
          mouldingSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await wait(500);
        const afterMoulding = canvas?.dataset.cameraPose;
        checks.push(check("Moulding selector found", Boolean(mouldingSelect && alternative),
          mouldingSelect && alternative ? `Changed to ${alternative.textContent?.trim()}` : "Moulding selector missing"));
        checks.push(check("Moulding change preserves camera pose",
          Boolean(beforeMoulding && afterMoulding && beforeMoulding === afterMoulding),
          beforeMoulding && afterMoulding
            ? `${beforeMoulding} → ${afterMoulding}`
            : "Camera pose was unavailable"));
      }
      if (scenario.inspect === "wall-viewer") {
        const roomImage = doc.querySelector<HTMLImageElement>(".wall-photo");
        checks.push(check("Room photograph loaded", Boolean(roomImage?.complete && roomImage.naturalWidth > 0),
          roomImage ? `${roomImage.naturalWidth} × ${roomImage.naturalHeight}px` : "Room image missing"));
        checks.push(check("Wall composite mode active", Boolean(doc.querySelector(".wall-stage")),
          doc.querySelector(".wall-stage") ? "Wall stage present" : "Wall stage missing"));
      }
    }
    return checks;
  }

  async function runTests() {
    if (!selectedCount || status === "running") return;
    const runList = scenarios.filter((item) => selected.has(item.id));
    setStatus("running");
    setResults([]);
    const nextResults: TestResult[] = [];
    for (let index = 0; index < runList.length; index += 1) {
      const scenario = runList[index];
      setProgress(`${index + 1} of ${runList.length} · ${scenario.name}`);
      const started = performance.now();
      let checks: CheckResult[];
      try {
        const frame = await loadScenario(scenario);
        checks = await inspectScenario(scenario, frame);
      } catch (error) {
        checks = [check("Scenario completed", false, error instanceof Error ? error.message : "Unknown error")];
      }
      const result = recordHistory({
        id: scenario.id,
        name: scenario.name,
        room: scenario.room,
        status: checks.every((item) => item.passed) ? "passed" : "failed",
        durationMs: Math.round(performance.now() - started),
        checks,
        runAt: new Date().toISOString(),
      });
      nextResults.push(result);
      setResults([...nextResults]);
    }
    setStatus(nextResults.every((item) => item.status === "passed") ? "passed" : "failed");
    setProgress(`Completed ${nextResults.length} manual test${nextResults.length === 1 ? "" : "s"}`);
  }

  function downloadReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      appOrigin: window.location.origin,
      summary: totals,
      results,
      history,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `frame-visualiser-test-report-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="qa-app">
      <header className="qa-header">
        <div>
          <p className="qa-kicker">Admin / Visual QA</p>
          <h1>Test Centre</h1>
          <p>Tests only run when you start them. Results do not approve or replace visual baselines.</p>
        </div>
        <nav>
          <a href="/">Viewer</a>
          <a href="/room-calibrator/">Room admin</a>
          <span>Test centre</span>
        </nav>
      </header>

      <section className="qa-toolbar">
        <div className="qa-pack-buttons">
          <button onClick={() => setSelected(new Set(scenarios.map((item) => item.id)))}>All checks</button>
          <button onClick={() => selectPack("admin")}>Admin layout</button>
          <button onClick={() => selectPack("rooms")}>Room rendering</button>
          <button onClick={() => selectPack("mouldings")}>Moulding rendering</button>
        </div>
        <button className="qa-run" disabled={!selectedCount || status === "running"} onClick={runTests}>
          {status === "running" ? "Running…" : `Run ${selectedCount} selected`}
        </button>
      </section>

      <div className="qa-grid">
        <section className="qa-scenarios">
          <div className="qa-section-title">
            <h2>Manual test packs</h2>
            <span>{selectedCount} selected</span>
          </div>
          {scenarios.map((scenario) => {
            const result = results.find((item) => item.id === scenario.id);
            return (
              <label className={`qa-scenario ${result?.status || ""}`} key={scenario.id}>
                <input type="checkbox" checked={selected.has(scenario.id)} onChange={() => toggle(scenario.id)} />
                <span className="qa-scenario-copy">
                  <b>{scenario.name}</b>
                  <small>{scenario.description}</small>
                  <em>{scenario.width} × {scenario.height} · {scenario.room}</em>
                </span>
                <span className="qa-state">{result?.status || "ready"}</span>
              </label>
            );
          })}
        </section>

        <section className="qa-results">
          <div className="qa-section-title">
            <h2>Latest run</h2>
            <span className={`qa-summary ${status}`}>{progress || "Not run"}</span>
          </div>
          {!results.length && <div className="qa-empty">Choose a pack and run it when you are ready to review a change.</div>}
          {results.map((result) => (
            <article className={`qa-result ${result.status}`} key={result.id}>
              <header><b>{result.name}</b><span>{result.status} · {(result.durationMs / 1000).toFixed(1)}s</span></header>
              {result.status === "passed" && result.previousStatus === "failed" && (
                <div className="qa-recovered">Recovered · previously failed, now passed</div>
              )}
              <ul>
                {result.checks.map((item) => (
                  <li className={item.passed ? "pass" : "fail"} key={item.name}>
                    <span>{item.passed ? "✓" : "×"}</span><b>{item.name}</b><small>{item.detail}</small>
                  </li>
                ))}
              </ul>
            </article>
          ))}
          {results.length > 0 && (
            <button className="qa-download" onClick={downloadReport}>Download JSON report</button>
          )}
        </section>
      </div>

      <section className="qa-history">
        <div className="qa-section-title">
          <h2>Run history</h2>
          <span>{history.length} saved result{history.length === 1 ? "" : "s"}</span>
        </div>
        {!history.length && <div className="qa-empty">Completed test results will be retained here in this browser.</div>}
        <div className="qa-history-list">
          {history.map((result, index) => (
            <div className={`qa-history-row ${result.status}`} key={`${result.id}-${result.runAt}-${index}`}>
              <span className="history-dot">{result.status === "passed" ? "✓" : "×"}</span>
              <b>{result.name}</b>
              <span>{result.status}</span>
              {result.status === "passed" && result.previousStatus === "failed" ? <em>failed → passed</em> : <i />}
              <time dateTime={result.runAt}>{new Date(result.runAt).toLocaleString()}</time>
            </div>
          ))}
        </div>
      </section>

      <section className="qa-viewport-section">
        <div className="qa-section-title">
          <h2>Live test viewport</h2>
          <span>{activeScenario ? `${activeScenario.width} × ${activeScenario.height}` : "Waiting"}</span>
        </div>
        <p>This is the exact isolated screen being checked. It remains visible so a numerical pass can still be visually reviewed.</p>
        <div className="qa-viewport-shell">
          {activeScenario ? (
            <iframe
              ref={iframeRef}
              title={`Test viewport: ${activeScenario.name}`}
              style={{ width: activeScenario.width, height: activeScenario.height }}
            />
          ) : <div className="qa-viewport-placeholder">Run a test pack to load its first screen.</div>}
        </div>
      </section>
    </main>
  );
}
