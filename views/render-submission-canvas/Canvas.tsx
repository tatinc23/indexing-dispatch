// The submission canvas UI ("Indexing Dispatch"). It knows nothing about MCP: it gets props (CanvasProps) and a Runner that
// calls the real tools. view.tsx wires the Runner to the host; harness/canvas wires it to mock results for screenshots only.
// Every number, status and sentence on screen comes from a tool result (src/contract.ts, SubmitResult) or from what the
// user typed. Nothing is seeded or defaulted.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { AuditResult, CanvasProps, CloudflareBaseline, IndexNowResult } from "../../src/contract.js";
import type { SubmitResult } from "../../src/schema.js";
import {
  BRAVE_STATUS_LABEL,
  CLOUDFLARE_OFF_REASON,
  CLOUDFLARE_OFF_SHORT,
  MAX_SEQUENTIAL_URLS,
  UNITS,
  X_LIMIT,
  auditPhase,
  bravePhase,
  braveSummary,
  braveTotals,
  buildPatchTabs,
  buildRecheckPrompt,
  buildSocialDrafts,
  cloudflarePhase,
  defaultKeyLocation,
  domainLabel,
  formatBytes,
  formatMs,
  formatNumber,
  gapCount,
  hostsOf,
  indexNowKeyProblem,
  indexNowPhase,
  initialUrlText,
  parseUrlList,
  planIndexNow,
  suggestedFilesBundle,
  unitStatus,
  urlsWithFacts,
  xWeightedLength,
  zoneIdProblem,
  type Facts,
  type PatchTab,
  type ToolId,
  type ToolPhase,
} from "./lib.js";

export interface Runner {
  brave(args: { targetUrl: string }): Promise<SubmitResult>;
  indexNow(args: { host: string; key: string; urls: string[]; keyLocation?: string }): Promise<IndexNowResult>;
  audit(args: { targetUrl: string; strategy?: "mobile" | "desktop" }): Promise<AuditResult>;
  cloudflare(args: { zoneId: string; previous?: CloudflareBaseline }): Promise<CloudflareBaseline>;
}

// ---------- small pieces ----------

const PHASE_WORD: Record<ToolPhase, string> = {
  idle: "Not run",
  running: "Running",
  ready: "Done",
  warning: "Needs attention",
  error: "Failed",
};

function Pip({ phase }: { phase: ToolPhase }) {
  return (
    <svg className={`pip pip-${phase}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      {phase === "idle" && <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {phase === "running" && (
        <circle className="spin" cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="20 14" strokeLinecap="round" />
      )}
      {phase === "ready" && <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
      {phase === "warning" && (
        <>
          <path d="M8 2.5l6 10.5H2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8 6.8v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="11.5" r=".9" fill="currentColor" />
        </>
      )}
      {phase === "error" && <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}

function Status({ phase, text }: { phase: ToolPhase; text?: string }) {
  return (
    <span className={`status status-${phase}`}>
      <Pip phase={phase} />
      <span>{text ?? PHASE_WORD[phase]}</span>
    </span>
  );
}

type IconName = "share" | "file" | "calendar" | "close" | "copy" | "check" | "out" | "reset";
function Icon({ name }: { name: IconName }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;
  switch (name) {
    case "share":
      return (
        <svg {...common}>
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
        </svg>
      );
    case "file":
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5M10 13l-2 2 2 2M14 13l2 2-2 2" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="1" />
          <path d="M3 10h18M8 3v4M16 3v4M12 13v3l2 1" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          <rect x="9" y="9" width="12" height="12" rx="1" />
          <path d="M5 15V5a1 1 0 0 1 1-1h10" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="M5 12.5l4.5 4.5L19 7" />
        </svg>
      );
    case "out":
      return (
        <svg {...common}>
          <path d="M7 17L17 7M8 7h9v9" />
        </svg>
      );
    case "reset":
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
        </svg>
      );
  }
}

function Detail({ summary, children, defaultOpen }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="detail" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="detail-body">{children}</div>
    </details>
  );
}

function Pre({ children, label }: { children: string; label: string }) {
  return (
    <pre className="pre" tabIndex={0} aria-label={label}>
      {children}
    </pre>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="rows">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

type Tone = "ok" | "warn" | "bad" | "plain";
function Tiles({ tiles }: { tiles: { k: string; v: ReactNode; tone?: Tone }[] }) {
  return (
    <div className="tiles">
      {tiles.map((t) => (
        <div className="tile" key={t.k}>
          <span className="tile-k">{t.k}</span>
          <span className={`tile-v tone-${t.tone ?? "plain"}`}>{t.v}</span>
        </div>
      ))}
    </div>
  );
}

/** Clipboard in a sandboxed iframe can be blocked; fall back to execCommand, and report failure honestly. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ---------- state ----------

interface BraveRow {
  url: string;
  state: "waiting" | "running" | "done" | "skipped";
  result?: SubmitResult;
  error?: string;
}
interface AuditRow {
  url: string;
  state: "waiting" | "running" | "done" | "skipped";
  result?: AuditResult;
  error?: string;
}
interface Single<T> {
  running: boolean;
  result?: T;
  error?: string;
  skipped?: string;
}
type DrawerKind = "social" | "patch" | "recheck";

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : "The tool call failed.");
const toneOfPhase = (p: ToolPhase): Tone => (p === "ready" ? "ok" : p === "warning" ? "warn" : p === "error" ? "bad" : "plain");

// ---------- the canvas ----------

export function Canvas({ props, runner }: { props: CanvasProps; runner: Runner }) {
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const stopRef = useRef(false);

  const [urlText, setUrlText] = useState(() => initialUrlText(props));
  const [included, setIncluded] = useState<Record<ToolId, boolean>>({ brave: true, indexnow: false, audit: true, cloudflare: false });
  const [viewing, setViewing] = useState<ToolId>("brave");
  const [key, setKey] = useState("");
  const [keyLocation, setKeyLocation] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [strategy, setStrategy] = useState<"mobile" | "desktop">("mobile");

  const [running, setRunning] = useState(false);
  const [braveRows, setBraveRows] = useState<BraveRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [indexNow, setIndexNow] = useState<Single<IndexNowResult>>({ running: false });
  const [indexNowUrls, setIndexNowUrls] = useState<string[]>([]);
  const [cloudflare, setCloudflare] = useState<Single<CloudflareBaseline>>({ running: false });
  const [live, setLive] = useState("");
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [drawer, setDrawer] = useState<DrawerKind | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const drawerOpener = useRef<HTMLElement | null>(null);

  const { cloudflare: cfOn, pageSpeed: psOn } = props.enabledTools;
  const parsed = useMemo(() => parseUrlList(urlText), [urlText]);
  const urls = parsed.urls;
  const sequentialUrls = urls.slice(0, MAX_SEQUENTIAL_URLS);
  const overLimit = urls.length - sequentialUrls.length;
  const hosts = useMemo(() => hostsOf(urls), [urls]);

  // The Cloudflare unit cannot run when the server does not have it.
  const useCf = included.cloudflare && cfOn;
  const indexPlan = useMemo(() => planIndexNow(urls, key.trim(), keyLocation), [urls, key, keyLocation]);
  const zoneIssue = zoneIdProblem(zoneId.trim());

  const blockers: string[] = [];
  if (urls.length === 0) blockers.push("Add at least one valid URL.");
  if (!included.brave && !included.indexnow && !included.audit && !useCf) blockers.push("Include at least one unit in the run.");
  if (included.indexnow && urls.length > 0 && !indexPlan.ok) blockers.push(`IndexNow: ${indexPlan.problem}`);
  if (useCf && zoneIssue) blockers.push(`Cloudflare: ${zoneIssue}`);

  // Toasts
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!confirmReset) return;
    const t = window.setTimeout(() => setConfirmReset(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmReset]);
  const say = (text: string) => setToast({ id: Date.now(), text });

  const copy = async (text: string, what: string) => {
    const ok = await copyText(text);
    say(ok ? `Copied ${what}.` : `Copy was blocked here. Select the text and copy it by hand.`);
  };

  // ---- run ----
  const run = async () => {
    if (running || blockers.length > 0) return;
    stopRef.current = false;
    setRunning(true);
    setLive("Run started.");
    const r = runnerRef.current;
    const seq = sequentialUrls;

    // Reset only the units that are about to run.
    if (included.indexnow) setIndexNow({ running: true });
    if (useCf) setCloudflare({ running: true });
    if (included.audit) setAuditRows(seq.map((url) => ({ url, state: "waiting" })));
    if (included.brave) setBraveRows(seq.map((url) => ({ url, state: "waiting" })));

    const stopped = () => stopRef.current;

    if (included.indexnow && indexPlan.args) {
      try {
        setIndexNowUrls(indexPlan.args.urls);
        const res = await r.indexNow(indexPlan.args);
        setIndexNow({ running: false, result: res });
        setLive(`IndexNow: ${res.status}.`);
      } catch (e) {
        setIndexNow({ running: false, error: errText(e) });
        setLive("IndexNow failed.");
      }
    }

    if (included.audit) {
      for (let i = 0; i < seq.length; i++) {
        if (stopped()) {
          setAuditRows((rows) => rows.map((row, j) => (j >= i ? { ...row, state: "skipped" } : row)));
          break;
        }
        setAuditRows((rows) => rows.map((row, j) => (j === i ? { ...row, state: "running" } : row)));
        try {
          const res = await r.audit({ targetUrl: seq[i], ...(psOn ? { strategy } : {}) });
          setAuditRows((rows) => rows.map((row, j) => (j === i ? { ...row, state: "done", result: res } : row)));
          setLive(`Audit ${i + 1} of ${seq.length}: ${res.status}.`);
        } catch (e) {
          setAuditRows((rows) => rows.map((row, j) => (j === i ? { ...row, state: "done", error: errText(e) } : row)));
          setLive(`Audit ${i + 1} of ${seq.length} failed.`);
        }
      }
    }

    if (useCf) {
      if (stopped()) {
        setCloudflare({ running: false, skipped: "Stopped before this ran." });
      } else {
        try {
          const res = await r.cloudflare({ zoneId: zoneId.trim() });
          setCloudflare({ running: false, result: res });
          setLive(`Cloudflare baseline: ${res.status}.`);
        } catch (e) {
          setCloudflare({ running: false, error: errText(e) });
          setLive("Cloudflare baseline failed.");
        }
      }
    }

    // Brave last: slowest, and strictly one URL at a time. Never retried here.
    if (included.brave) {
      for (let i = 0; i < seq.length; i++) {
        if (stopped()) {
          setBraveRows((rows) => rows.map((row, j) => (j >= i ? { ...row, state: "skipped" } : row)));
          break;
        }
        setBraveRows((rows) => rows.map((row, j) => (j === i ? { ...row, state: "running" } : row)));
        setLive(`Brave: submitting ${i + 1} of ${seq.length}.`);
        try {
          const res = await r.brave({ targetUrl: seq[i] });
          setBraveRows((rows) => rows.map((row, j) => (j === i ? { ...row, state: "done", result: res } : row)));
          setLive(`Brave ${i + 1} of ${seq.length}: ${BRAVE_STATUS_LABEL[res.status]}.`);
        } catch (e) {
          setBraveRows((rows) => rows.map((row, j) => (j === i ? { ...row, state: "done", error: errText(e) } : row)));
          setLive(`Brave ${i + 1} of ${seq.length} failed.`);
        }
      }
    }

    setRunning(false);
    setLive(stopped() ? "Run stopped." : "Run finished.");
  };

  // ---- derived phases ----
  const braveDone = braveRows.filter((x) => x.result).map((x) => x.result as SubmitResult);
  const braveErrors = braveRows.filter((x) => x.error).length;
  const braveBusy = braveRows.some((x) => x.state === "running" || x.state === "waiting");
  const bravePh: ToolPhase = braveBusy ? "running" : braveRows.length === 0 ? "idle" : braveErrors > 0 ? "error" : bravePhase(braveDone);
  const braveProgress = `${braveRows.filter((x) => x.state === "done").length}/${braveRows.length}`;

  const auditOk = auditRows.filter((x) => x.result).map((x) => x.result as AuditResult);
  const auditBusy = auditRows.some((x) => x.state === "running" || x.state === "waiting");
  const auditPh: ToolPhase = auditBusy
    ? "running"
    : auditRows.length === 0
      ? "idle"
      : auditRows.some((x) => x.error)
        ? "error"
        : auditOk.some((a) => auditPhase(a) === "error")
          ? "error"
          : auditOk.some((a) => auditPhase(a) === "warning")
            ? "warning"
            : "ready";
  const auditProgress = `${auditRows.filter((x) => x.state === "done").length}/${auditRows.length}`;

  const indexPh: ToolPhase = indexNow.running ? "running" : indexNow.error ? "error" : indexNow.result ? indexNowPhase(indexNow.result) : "idle";
  const cfPh: ToolPhase = cloudflare.running ? "running" : cloudflare.error ? "error" : cloudflare.result ? cloudflarePhase(cloudflare.result) : "idle";

  const facts: Facts = { brave: braveDone, indexNow: indexNow.result, indexNowUrls, audits: auditOk };
  const baseline = cloudflare.result?.status === "ok" ? cloudflare.result : undefined;
  const hasResults = braveDone.length > 0 || !!indexNow.result || auditOk.length > 0 || !!cloudflare.result;

  const phases: Record<ToolId, ToolPhase> = { brave: bravePh, indexnow: indexPh, audit: auditPh, cloudflare: cfPh };
  const progress: Partial<Record<ToolId, string>> = { brave: braveProgress, audit: auditProgress };
  const noUrls = urls.length === 0;
  const blocked: Record<ToolId, boolean> = {
    brave: noUrls,
    audit: noUrls,
    indexnow: noUrls || !indexPlan.ok,
    cloudflare: !!zoneIssue,
  };
  const enabled: Record<ToolId, boolean> = { brave: true, indexnow: true, audit: true, cloudflare: cfOn };

  const keyHost = hosts.length === 1 ? hosts[0] : "<host>";
  const keyFileUrl = defaultKeyLocation(keyHost, key.trim() || "<key>");

  const reset = () => {
    if (running) return;
    if (hasResults && !confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    setUrlText(initialUrlText(props));
    setBraveRows([]);
    setAuditRows([]);
    setIndexNow({ running: false });
    setIndexNowUrls([]);
    setCloudflare({ running: false });
    setDrawer(null);
    setLive("Workspace reset.");
  };

  const openDrawer = (kind: DrawerKind, opener: HTMLElement) => {
    drawerOpener.current = opener;
    setDrawer(kind);
  };
  const closeDrawer = () => {
    setDrawer(null);
    const el = drawerOpener.current;
    if (el) window.setTimeout(() => el.focus(), 0);
  };

  const unit = UNITS.find((u) => u.id === viewing)!;
  const viewPhase = phases[viewing];

  // Text in the receipt bar's right corner. Only observed facts.
  const barText: Record<ToolId, string> = {
    brave: braveRows.length === 0 ? "NOT RUN" : braveBusy ? `RUNNING ${braveProgress}` : braveSummary(braveDone, braveRows.length).toUpperCase(),
    indexnow: indexNow.running ? "RUNNING" : indexNow.result ? indexNowLabel(indexNow.result).toUpperCase() : indexNow.error ? "FAILED" : "NOT RUN",
    audit: auditRows.length === 0 ? "NOT RUN" : auditBusy ? `RUNNING ${auditProgress}` : `${auditOk.length} OF ${auditRows.length} READ`,
    cloudflare: !cfOn ? "SELF-HOST ONLY" : cloudflare.running ? "RUNNING" : cloudflare.result ? cloudflare.result.status.toUpperCase().replace("_", " ") : cloudflare.error ? "FAILED" : "NOT RUN",
  };

  const patchTabs = useMemo(() => buildPatchTabs(auditOk), [auditOk]);
  const recheck = buildRecheckPrompt(baseline);
  const social = urlsWithFacts(facts);

  return (
    <div className={`canvas${drawer ? " drawer-open" : ""}`}>
      <div className="shell envelope" inert={drawer !== null}>
        <div className="env-in">
        <header className="head">
          <Stamp />
          <h1 className="mark">
            <Logo />
            <span>Indexing Dispatch</span>
          </h1>
          <p className="tagline">Submit URLs, audit AI readiness, snapshot Cloudflare traffic.</p>
          <div className="head-top">
            <button type="button" className="ghost" onClick={reset} disabled={running}>
              <Icon name="reset" />
              <span>{confirmReset ? "Click again to clear results" : "Reset workspace"}</span>
            </button>
          </div>
          {props.mode === "autonomous" && <p className="note">Autonomous mode was requested. This canvas still waits for you to press Initiate run.</p>}
        </header>

        <div className="layout">
          <aside className="rail" aria-labelledby="rail-h">
            <h2 id="rail-h" className="label">
              Send with
            </h2>
            <ul className="units">
              {UNITS.map((u) => {
                const st = unitStatus({ enabled: enabled[u.id], included: included[u.id], blocked: blocked[u.id], phase: phases[u.id], progress: progress[u.id] });
                const isCf = u.id === "cloudflare";
                return (
                  <li key={u.id} className={`unit tone-${st.tone}${viewing === u.id ? " is-selected" : ""}`}>
                    <button type="button" className="unit-main" onClick={() => setViewing(u.id)} aria-current={viewing === u.id ? "true" : undefined} aria-describedby={`unit-${u.id}-d`}>
                      <span className="unit-top">
                        <span className="unit-num">
                          <span className="sr-only">Unit </span>
                          <span className="pm">{u.num}</span>
                        </span>
                        <span className="unit-word">{st.word}</span>
                      </span>
                      <span className="unit-title">{u.title}</span>
                      <span id={`unit-${u.id}-d`} className="unit-blurb">
                        {u.blurb}
                      </span>
                    </button>
                    {isCf && !cfOn ? (
                      <p className="unit-reason">{CLOUDFLARE_OFF_SHORT}</p>
                    ) : (
                      <label className="unit-include">
                        <input type="checkbox" className="check" checked={included[u.id]} onChange={() => setIncluded((s) => ({ ...s, [u.id]: !s[u.id] }))} disabled={running} />
                        <span>In this run</span>
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </aside>

          <main className="main">
            <section className="buffer" aria-labelledby="buffer-h">
              <div className="buffer-head">
                <h2 id="buffer-h" className="label">
                  Pages to send
                </h2>
                <p id="urls-hint" className="count" aria-live="polite">
                  {urls.length} valid URL{urls.length === 1 ? "" : "s"}
                  {hosts.length > 0 ? ` · ${domainLabel(hosts)}` : ""}
                </p>
              </div>
              <div className="buffer-body">
                <div className="buffer-field">
                  <label htmlFor="urls" className="sr-only">
                    URLs, one per line
                  </label>
                  <textarea
                    id="urls"
                    className="area"
                    rows={Math.min(8, Math.max(3, urlText.split("\n").length + 1))}
                    value={urlText}
                    onChange={(e) => setUrlText(e.target.value)}
                    placeholder={"https://example.com/\nhttps://example.com/pricing"}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    disabled={running}
                    aria-describedby="urls-hint urls-notes"
                  />
                </div>
                <div className="buffer-go">
                  <button type="button" className="go" onClick={() => void run()} disabled={running || blockers.length > 0} aria-describedby="run-hint">
                    <span>{running ? "Running..." : "Initiate run"}</span>
                  </button>
                  {running && (
                    <button type="button" className="ghost wide" onClick={() => (stopRef.current = true)}>
                      Stop after current call
                    </button>
                  )}
                </div>
              </div>
              <div id="urls-notes" className="buffer-notes">
                {parsed.duplicates > 0 && (
                  <p className="hint">
                    {parsed.duplicates} duplicate{parsed.duplicates === 1 ? "" : "s"} ignored.
                  </p>
                )}
                {parsed.problems.length > 0 && (
                  <ul className="problems" aria-label="URL problems">
                    {parsed.problems.slice(0, 5).map((p, i) => (
                      <li key={i}>
                        <code>{p.value}</code> {p.reason}
                      </li>
                    ))}
                    {parsed.problems.length > 5 && <li>{parsed.problems.length - 5} more.</li>}
                  </ul>
                )}
                {overLimit > 0 && (included.brave || included.audit) && (
                  <p className="hint warn">
                    Brave and the audit take the first {MAX_SEQUENTIAL_URLS} URLs per run. {overLimit} more will not run until you start another run.
                  </p>
                )}
                <p id="run-hint" className="hint">
                  {blockers.length > 0 ? blockers[0] : running ? "A call already in flight cannot be cancelled; the rest are skipped." : "Each Brave submission is sent once. Failed ones are not retried. Nothing repeats on its own."}
                </p>
              </div>
            </section>

            <section className="receipt" aria-labelledby="receipt-h">
              <div className="bar">
                <span className="bar-l">
                  <span className="pm" aria-hidden="true">{unit.num}</span>
                  <span>Receipt, unit {unit.num}</span>
                </span>
                <span className={`bar-r tone-${toneOfPhase(viewPhase)}`}>{barText[viewing]}</span>
              </div>
              <div className="receipt-body">
                <div className="receipt-title">
                  <h2 id="receipt-h" className="title">
                    {unit.title}
                  </h2>
                  {urls.length > 0 && (
                    <p className="meta">
                      {domainLabel(hosts)} · {urls.length} URL{urls.length === 1 ? "" : "s"}
                    </p>
                  )}
                </div>

                {viewing === "brave" && (
                  <BravePanel rows={braveRows} included={included.brave} />
                )}
                {viewing === "indexnow" && (
                  <IndexNowPanel
                    included={included.indexnow}
                    state={indexNow}
                    keyValue={key}
                    setKey={setKey}
                    keyLocation={keyLocation}
                    setKeyLocation={setKeyLocation}
                    keyFileUrl={keyFileUrl}
                    keyHost={keyHost}
                    problem={urls.length > 0 && !indexPlan.ok ? indexPlan.problem : undefined}
                    disabled={running}
                  />
                )}
                {viewing === "audit" && <AuditPanel rows={auditRows} included={included.audit} psOn={psOn} strategy={strategy} setStrategy={setStrategy} disabled={running} />}
                {viewing === "cloudflare" && (
                  <CloudflarePanel enabled={cfOn} included={included.cloudflare} state={cloudflare} zoneId={zoneId} setZoneId={setZoneId} disabled={running} />
                )}

                {hasResults && (
                  <div className="actions">
                    <h3 className="label">Use the results</h3>
                    <div className="action-row">
                      <button type="button" className="action" disabled={social.length === 0} onClick={(e) => openDrawer("social", e.currentTarget)}>
                        <Icon name="share" />
                        <span>Draft social launch post</span>
                        <Icon name="out" />
                      </button>
                      <button type="button" className="action" onClick={(e) => openDrawer("patch", e.currentTarget)}>
                        <Icon name="file" />
                        <span>Copy LLM patch</span>
                        <Icon name="out" />
                      </button>
                      {recheck && (
                        <button type="button" className="action" onClick={(e) => openDrawer("recheck", e.currentTarget)}>
                          <Icon name="calendar" />
                          <span>Copy 7-day re-check prompt</span>
                          <Icon name="out" />
                        </button>
                      )}
                    </div>
                    {social.length === 0 && <p className="hint">A social draft needs a result from Brave, IndexNow or the audit.</p>}
                    {auditOk.length === 0 && <p className="hint">The LLM patch comes from the site audit. Include Unit 03 and run it.</p>}
                  </div>
                )}
              </div>
            </section>
          </main>
        </div>
        </div>
      </div>

      {drawer && (
        <Drawer
          title={drawer === "social" ? "Draft social launch post" : drawer === "patch" ? "LLM patch" : "7-day re-check prompt"}
          onClose={closeDrawer}
        >
          {drawer === "social" && <SocialDrawer facts={facts} urls={social} onCopy={copy} />}
          {drawer === "patch" && <PatchDrawer tabs={patchTabs} onCopy={copy} />}
          {drawer === "recheck" && recheck && <RecheckDrawer prompt={recheck} onCopy={copy} />}
        </Drawer>
      )}

      <div className="sr-only" role="status" aria-live="polite">
        {live}
      </div>
      <div className="toast-zone" role="status" aria-live="polite">
        {toast && (
          <div key={toast.id} className="toast">
            {toast.text}
          </div>
        )}
      </div>
    </div>
  );
}

// Decorative: the postage stamp and the mark, drawn like the dispatch.tatinc.us page.
function Stamp() {
  return (
    <span className="stamp" aria-hidden="true">
      <span className="stamp-face">
        <span className="stamp-word">Air</span>
        <span className="stamp-word">mail</span>
      </span>
    </span>
  );
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
      <rect x="2" y="6" width="28" height="20" rx="2" fill="#FBFCFE" stroke="#13203F" strokeWidth="2.5" />
      <path d="M3.5 8l12.5 9 12.5-9" fill="none" stroke="#1D4FC4" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- unit panels ----------

function Note({ children }: { children: ReactNode }) {
  return <p className="panel-note">{children}</p>;
}

function NotIncluded({ included }: { included: boolean }) {
  return included ? null : <Note>This unit is not in the next run. Tick "In this run" on its card to include it.</Note>;
}

function BravePanel({ rows, included }: { rows: BraveRow[]; included: boolean }) {
  const done = rows.filter((r) => r.result).map((r) => r.result as SubmitResult);
  const t = braveTotals(done);
  return (
    <>
      <Note>One URL at a time, about 10 to 40 seconds each. Each URL is submitted once and never retried. "Accepted" means Brave's form confirmed it received the URL, not that the page is indexed.</Note>
      <NotIncluded included={included} />
      {rows.length === 0 ? (
        included && <p className="empty">No run yet. Initiate a run to submit the URLs above.</p>
      ) : (
        <>
          {done.length > 0 && (
            <Tiles
              tiles={[
                { k: "Accepted", v: `${t.accepted} of ${rows.length}`, tone: t.accepted === rows.length ? "ok" : "plain" },
                { k: "Not accepted", v: String(t.other), tone: t.other > 0 ? "warn" : "plain" },
                { k: "Time in Brave", v: formatMs(t.ms) },
              ]}
            />
          )}
          <ul className="res-list" aria-label="Brave submissions">
            {rows.map((row) => (
              <BraveItem key={row.url} row={row} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function BraveItem({ row }: { row: BraveRow }) {
  const r = row.result;
  const phase: ToolPhase =
    row.state === "running" ? "running" : row.state === "waiting" || row.state === "skipped" ? "idle" : row.error ? "error" : r?.status === "accepted" ? "ready" : r?.status === "error" ? "error" : "warning";
  const word = row.state === "waiting" ? "Waiting" : row.state === "skipped" ? "Not run" : row.state === "running" ? "Submitting" : row.error ? "Could not complete" : r ? BRAVE_STATUS_LABEL[r.status] : "";
  return (
    <li className={`res phase-${phase}`}>
      <div className="res-head">
        <span className="url" title={row.url}>
          {row.url}
        </span>
        <Status phase={phase} text={word} />
      </div>
      {row.error && <p className="err-text">{row.error}</p>}
      {r && (
        <>
          <p className="res-msg">{r.message}</p>
          <Detail summary="Details">
            <Rows
              rows={[
                ["Time", formatMs(r.durationMs)],
                ...(r.confirmationText ? ([["Brave said", `"${r.confirmationText}"`]] as [string, ReactNode][]) : []),
                ...(r.errorCode ? ([["Reason", r.errorCode]] as [string, ReactNode][]) : []),
                ...(r.retryAfterSeconds ? ([["Do not retry before", `${r.retryAfterSeconds} s`]] as [string, ReactNode][]) : []),
              ]}
            />
            {r.diagnostics && r.diagnostics.observed.length > 0 && (
              <>
                <p className="mini">What Brave's page showed, in order</p>
                <ol className="observed">
                  {r.diagnostics.observed.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ol>
              </>
            )}
            {r.diagnostics?.domExcerpt && <Pre label="Text on Brave's page at the end of the run">{r.diagnostics.domExcerpt}</Pre>}
          </Detail>
        </>
      )}
    </li>
  );
}

function indexNowLabel(r: IndexNowResult): string {
  switch (r.status) {
    case "submitted":
      return `Submitted ${r.urlCount} URL${r.urlCount === 1 ? "" : "s"}`;
    case "key_not_verified":
      return "Key file not verified";
    case "rejected":
      return "Rejected";
    case "blocked":
      return "Blocked";
    default:
      return "Failed";
  }
}

function IndexNowPanel(p: {
  included: boolean;
  state: Single<IndexNowResult>;
  keyValue: string;
  setKey: (v: string) => void;
  keyLocation: string;
  setKeyLocation: (v: string) => void;
  keyFileUrl: string;
  keyHost: string;
  problem?: string;
  disabled: boolean;
}) {
  const r = p.state.result;
  return (
    <>
      <Note>One request to api.indexnow.org, which the protocol shares with participating engines. The server first fetches your key file and sends nothing if it does not match the key.</Note>
      <NotIncluded included={p.included} />
      <div className="opts">
        <label htmlFor="inkey" className="field-label">
          Your IndexNow key
        </label>
        <input
          id="inkey"
          className="input"
          value={p.keyValue}
          onChange={(e) => p.setKey(e.target.value)}
          disabled={p.disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-describedby="inkey-hint"
          aria-invalid={p.keyValue.trim() !== "" && indexNowKeyProblem(p.keyValue.trim()) !== null}
        />
        <p id="inkey-hint" className="hint">
          The key file must already be live at <code>{p.keyFileUrl}</code> and contain the key.
        </p>
        <Detail summary="Key file is somewhere else">
          <label htmlFor="inloc" className="field-label">
            Key file location (optional)
          </label>
          <input
            id="inloc"
            className="input"
            value={p.keyLocation}
            onChange={(e) => p.setKeyLocation(e.target.value)}
            disabled={p.disabled}
            placeholder={`https://${p.keyHost}/keys/your-key.txt`}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
          <p className="hint">Must be on the same host as the URLs.</p>
        </Detail>
        {p.problem && p.included && <p className="hint bad">{p.problem}</p>}
      </div>
      {p.state.error && <p className="err-text">{p.state.error}</p>}
      {p.state.running && <p className="empty">Sending the request...</p>}
      {r && (
        <>
          <Tiles
            tiles={[
              { k: "Status", v: indexNowLabel(r), tone: toneOfPhase(indexNowPhase(r)) },
              { k: "URLs sent", v: formatNumber(r.urlCount) },
              { k: "Key file", v: r.keyVerified ? "Matched the key" : "Not verified", tone: r.keyVerified ? "ok" : "warn" },
            ]}
          />
          <p className="res-msg">{r.message}</p>
          <Rows rows={[["Host", r.host], ["Key file", r.keyLocation], ["Time", formatMs(r.durationMs)]]} />
          {r.engines.length > 0 && (
            <ul className="res-list" aria-label="Endpoint responses">
              {r.engines.map((e) => (
                <li className="res" key={e.endpoint}>
                  <div className="res-head">
                    <span className="url">{e.engine}</span>
                    <Status phase={e.ok ? "ready" : "error"} text={e.httpStatus ? `HTTP ${e.httpStatus}` : e.ok ? "OK" : "No answer"} />
                  </div>
                  <p className="res-msg">{e.message}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

const SEV_WORD = { info: "Note", warn: "Check", missing: "Missing" } as const;

function AuditPanel(p: { rows: AuditRow[]; included: boolean; psOn: boolean; strategy: "mobile" | "desktop"; setStrategy: (s: "mobile" | "desktop") => void; disabled: boolean }) {
  const ok = p.rows.filter((r) => r.result?.status === "ok").map((r) => r.result as AuditResult);
  const seenFiles = new Set<string>();
  ok.flatMap((a) => a.suggestedFiles).forEach((f) => seenFiles.add(`${f.kind}\n${f.path}\n${f.content}`));
  return (
    <>
      <Note>Reads each page, then its llms.txt, robots.txt and sitemap. It lists gaps and drafts files from what it read.</Note>
      <NotIncluded included={p.included} />
      <div className="opts">
        {p.psOn ? (
          <div className="inline-field">
            <label htmlFor="strategy" className="field-label">
              PageSpeed test as
            </label>
            <select id="strategy" className="input select" value={p.strategy} onChange={(e) => p.setStrategy(e.target.value as "mobile" | "desktop")} disabled={p.disabled}>
              <option value="mobile">Mobile</option>
              <option value="desktop">Desktop</option>
            </select>
          </div>
        ) : (
          <p className="hint">PageSpeed scores are off on this server (no PageSpeed API key is set). The rest of the audit runs.</p>
        )}
      </div>
      {p.rows.length === 0 ? (
        p.included && <p className="empty">No run yet. Initiate a run to read the URLs above.</p>
      ) : (
        <>
          {ok.length > 0 && (
            <Tiles
              tiles={[
                { k: "Pages read", v: `${ok.length} of ${p.rows.length}`, tone: ok.length === p.rows.length ? "ok" : "warn" },
                { k: "Gaps flagged", v: String(ok.reduce((n, a) => n + gapCount(a), 0)), tone: ok.some((a) => gapCount(a) > 0) ? "warn" : "ok" },
                { k: "Files drafted", v: String(seenFiles.size) },
              ]}
            />
          )}
          <ul className="res-list" aria-label="Audit results">
            {p.rows.map((row) => (
              <AuditItem key={row.url} row={row} open={p.rows.length === 1} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function AuditItem({ row, open }: { row: AuditRow; open: boolean }) {
  const r = row.result;
  const phase: ToolPhase = row.state === "running" ? "running" : row.state === "waiting" || row.state === "skipped" ? "idle" : row.error ? "error" : r ? auditPhase(r) : "idle";
  const word =
    row.state === "waiting"
      ? "Waiting"
      : row.state === "skipped"
        ? "Not run"
        : row.state === "running"
          ? "Reading"
          : row.error
            ? "Failed"
            : r
              ? r.status === "ok"
                ? phase === "ready"
                  ? "No gaps found"
                  : "Gaps found"
                : r.status === "blocked"
                  ? "Refused"
                  : r.status === "unreachable"
                    ? "Unreachable"
                    : "Failed"
              : "";
  const head = (
    <>
      <span className="url" title={row.url}>
        {row.url}
      </span>
      <Status phase={phase} text={word} />
    </>
  );
  if (!r && !row.error) return <li className={`res phase-${phase}`}><div className="res-head">{head}</div></li>;
  const ai = r?.aiReadiness;
  return (
    <li className={`res phase-${phase}`}>
      <Detail summary={head} defaultOpen={open}>
        {row.error ? (
          <p className="err-text">{row.error}</p>
        ) : r ? (
          <>
            <p className="res-msg">{r.message}</p>
            <Tiles
              tiles={[
                ...(r.httpStatus ? [{ k: "HTTP status", v: String(r.httpStatus), tone: (r.httpStatus < 400 ? "ok" : "bad") as Tone }] : []),
                ...(r.page ? [{ k: "JSON-LD types", v: String(r.page.jsonLdTypes.length), tone: (r.page.jsonLdTypes.length > 0 ? "ok" : "warn") as Tone }] : []),
                ...(ai
                  ? [
                      { k: "llms.txt", v: ai.llmsTxt.present ? "Present" : "Missing", tone: (ai.llmsTxt.present ? "ok" : "warn") as Tone },
                      { k: "Sitemap", v: ai.sitemap.present ? "Present" : "Missing", tone: (ai.sitemap.present ? "ok" : "warn") as Tone },
                    ]
                  : []),
              ]}
            />
            <Rows
              rows={[
                ...(r.finalUrl && r.finalUrl !== r.targetUrl ? ([["Ended at", r.finalUrl]] as [string, ReactNode][]) : []),
                ...(r.page?.title ? ([["Title", r.page.title]] as [string, ReactNode][]) : []),
                ...(r.page?.description ? ([["Description", r.page.description]] as [string, ReactNode][]) : []),
                ...(r.page?.canonical ? ([["Canonical", r.page.canonical]] as [string, ReactNode][]) : []),
                ...(r.page ? ([["JSON-LD", r.page.jsonLdTypes.length > 0 ? r.page.jsonLdTypes.join(", ") : "none found"], ["Open Graph", r.page.hasOpenGraph ? "present" : "not found"]] as [string, ReactNode][]) : []),
                ...(ai ? ([["robots.txt", ai.robotsTxt.present ? "present" : "not found"]] as [string, ReactNode][]) : []),
                ["Time", formatMs(r.durationMs)],
              ]}
            />
            {ai && Object.keys(ai.robotsTxt.aiBots).length > 0 && (
              <>
                <p className="mini">AI-bot rules in robots.txt</p>
                <ul className="chips" aria-label="Crawler rules in robots.txt">
                  {Object.entries(ai.robotsTxt.aiBots).map(([bot, rule]) => (
                    <li key={bot} className={`chip rule-${rule}`}>
                      <span>{bot}</span> <b>{rule}</b>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <PageSpeedView ps={r.pageSpeed} />
            {r.findings.length > 0 && (
              <>
                <p className="mini">Findings</p>
                <ul className="findings">
                  {r.findings.map((f) => (
                    <li key={f.id}>
                      <Status phase={f.severity === "info" ? "ready" : "warning"} text={SEV_WORD[f.severity]} />
                      <span>{f.message}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : null}
      </Detail>
    </li>
  );
}

function PageSpeedView({ ps }: { ps: AuditResult["pageSpeed"] }) {
  if (!ps) return null;
  if (ps.status !== "ok") {
    return (
      <p className="hint">
        PageSpeed {ps.status === "skipped" ? "was skipped" : "failed"}
        {ps.reason ? `: ${ps.reason}` : "."}
      </p>
    );
  }
  const rows: [string, ReactNode][] = [];
  if (ps.performanceScore !== undefined) rows.push(["Performance score", String(ps.performanceScore)]);
  if (ps.seoScore !== undefined) rows.push(["SEO score", String(ps.seoScore)]);
  if (ps.lcpMs !== undefined) rows.push(["Largest contentful paint", formatMs(ps.lcpMs)]);
  if (ps.cls !== undefined) rows.push(["Layout shift (CLS)", String(ps.cls)]);
  if (ps.tbtMs !== undefined) rows.push(["Total blocking time", formatMs(ps.tbtMs)]);
  if (ps.ttfbMs !== undefined) rows.push(["Time to first byte", formatMs(ps.ttfbMs)]);
  return (
    <>
      <p className="mini">PageSpeed{ps.strategy ? ` (${ps.strategy})` : ""}</p>
      <Rows rows={rows} />
    </>
  );
}

function CloudflarePanel(p: { enabled: boolean; included: boolean; state: Single<CloudflareBaseline>; zoneId: string; setZoneId: (v: string) => void; disabled: boolean }) {
  if (!p.enabled) {
    return (
      <div className="off-box" role="note">
        <p className="off-head">Self-host only</p>
        <p>{CLOUDFLARE_OFF_REASON}</p>
      </div>
    );
  }
  const r = p.state.result;
  const rows: [string, ReactNode][] = [];
  if (r) {
    if (r.zoneId) rows.push(["Zone", r.zoneId]);
    if (r.windowStart || r.windowEnd) rows.push(["Window", `${r.windowStart ?? "?"} to ${r.windowEnd ?? "?"}`]);
    if (r.deltaVsPrevious) {
      const d = r.deltaVsPrevious;
      const sign = (n: number) => (n > 0 ? "+" : "") + formatNumber(n);
      rows.push(["Requests vs previous", sign(d.requests)], ["Bytes vs previous", `${d.bytes > 0 ? "+" : ""}${formatBytes(d.bytes)}`], ["AI bot requests vs previous", sign(d.aiBotRequests)]);
    }
  }
  return (
    <>
      <Note>Reads requests, bytes and AI bot requests for one zone. The server stores nothing: keep the result if you want to compare later.</Note>
      <NotIncluded included={p.included} />
      <div className="opts">
        <label htmlFor="zone" className="field-label">
          Cloudflare zone ID
        </label>
        <input id="zone" className="input" value={p.zoneId} onChange={(e) => p.setZoneId(e.target.value)} disabled={p.disabled} spellCheck={false} autoCapitalize="off" autoComplete="off" aria-describedby="zone-hint" />
        <p id="zone-hint" className="hint">
          Find it on the zone's Overview page in the Cloudflare dashboard. The server only reads zones its operator listed.
        </p>
      </div>
      {p.state.skipped && <p className="hint">{p.state.skipped}</p>}
      {p.state.error && <p className="err-text">{p.state.error}</p>}
      {p.state.running && <p className="empty">Reading analytics...</p>}
      {r && (
        <>
          {r.totals && (
            <Tiles
              tiles={[
                { k: "Requests", v: formatNumber(r.totals.requests) },
                { k: "Bytes", v: formatBytes(r.totals.bytes) },
                ...(r.totals.uniques !== undefined ? [{ k: "Uniques", v: formatNumber(r.totals.uniques) }] : []),
              ]}
            />
          )}
          <p className={`res-msg${r.status === "ok" ? "" : " err-text"}`}>{r.message}</p>
          <Rows rows={rows} />
          {r.aiBots && r.aiBots.length > 0 && (
            <>
              <p className="mini">AI bot requests</p>
              <ul className="chips" aria-label="AI bot requests">
                {r.aiBots.map((b) => (
                  <li className="chip" key={b.name}>
                    <span>{b.name}</span> <b>{formatNumber(b.requests)}</b>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}

// ---------- drawer ----------

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const hid = useId();

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const f = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (f.length === 0) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="drawer" role="dialog" aria-modal="true" aria-labelledby={hid} onKeyDown={onKeyDown}>
        <div className="drawer-head">
          <h2 id={hid} className="title">
            {title}
          </h2>
          <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close drawer">
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

function CopyBtn({ onClick, children, solid = true }: { onClick: () => void; children: ReactNode; solid?: boolean }) {
  return (
    <button type="button" className={solid ? "copy" : "copy outline"} onClick={onClick}>
      <Icon name="copy" />
      <span>{children}</span>
    </button>
  );
}

function Draft({ label, initial, limit, onCopy, copyWhat }: { label: string; initial: string; limit?: number; onCopy: (t: string, w: string) => void; copyWhat: string }) {
  const [text, setText] = useState(initial);
  const id = useId();
  const count = limit ? xWeightedLength(text) : [...text].length;
  const over = limit !== undefined && count > limit;
  return (
    <div className="draft">
      <div className="draft-head">
        <label htmlFor={id} className="draft-label">
          {label}
        </label>
        <span className={`draft-count${over ? " over" : ""}`} aria-live="polite">
          {count}
          {limit ? ` / ${limit}` : ""} chars
        </span>
      </div>
      <textarea id={id} className="area draft-area" value={text} onChange={(e) => setText(e.target.value)} rows={limit ? 6 : 10} spellCheck={false} />
      <div className="draft-foot">
        <CopyBtn solid={limit !== undefined} onClick={() => onCopy(text, copyWhat)}>
          Copy
        </CopyBtn>
        {over && <span className="hint bad">Over the limit by {count - (limit ?? 0)}.</span>}
      </div>
    </div>
  );
}

function SocialDrawer({ facts, urls, onCopy }: { facts: Facts; urls: string[]; onCopy: (t: string, w: string) => void }) {
  const [url, setUrl] = useState(urls[0]);
  const current = urls.includes(url) ? url : urls[0];
  const drafts = current ? buildSocialDrafts(facts, current) : null;
  const selId = useId();
  return (
    <>
      <p className="drawer-note">
        Drafted from what the tools returned in this session, one URL at a time. Edit before posting. "Accepted" or "submitted" means the receipt was confirmed, not that the page is indexed or ranked. The X count weights each link as 23 characters.
      </p>
      {urls.length > 1 && (
        <div className="opts">
          <label htmlFor={selId} className="field-label">
            URL
          </label>
          <select id={selId} className="input select" value={current} onChange={(e) => setUrl(e.target.value)}>
            {urls.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
      )}
      {drafts ? (
        <div key={drafts.url}>
          <Draft label={`X post (limit ${X_LIMIT})`} initial={drafts.x} limit={X_LIMIT} onCopy={onCopy} copyWhat="the X draft" />
          <Draft label="LinkedIn post" initial={drafts.linkedin} onCopy={onCopy} copyWhat="the LinkedIn draft" />
        </div>
      ) : (
        <p className="empty">No results for this URL yet.</p>
      )}
    </>
  );
}

function PatchDrawer({ tabs, onCopy }: { tabs: PatchTab[]; onCopy: (t: string, w: string) => void }) {
  const firstWithFiles = tabs.find((t) => t.files.length > 0)?.kind;
  const [active, setActive] = useState(firstWithFiles ?? tabs[0].kind);
  const tab = tabs.find((t) => t.kind === active) ?? tabs[0];
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const enabledTabs = tabs.filter((t) => t.files.length > 0);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    if (enabledTabs.length === 0) return;
    const i = enabledTabs.findIndex((t) => t.kind === active);
    const next = enabledTabs[(i + (e.key === "ArrowRight" ? 1 : enabledTabs.length - 1)) % enabledTabs.length];
    setActive(next.kind);
    refs.current[next.kind]?.focus();
  };

  return (
    <>
      <p className="drawer-note">Files drafted by the site audit from facts it read on your pages: the title, description and URL. Check them before you publish. The server writes nothing to your site.</p>
      <div className="tabs" role="tablist" aria-label="Suggested files" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button
            key={t.kind}
            ref={(el) => {
              refs.current[t.kind] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.kind}`}
            aria-selected={active === t.kind}
            aria-controls="patch-panel"
            tabIndex={active === t.kind ? 0 : -1}
            disabled={t.files.length === 0}
            className="tab"
            onClick={() => setActive(t.kind)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ul className="why-off">
        {tabs
          .filter((t) => t.files.length === 0)
          .map((t) => (
            <li key={t.kind}>
              <b>{t.label}</b> {t.reason}
            </li>
          ))}
      </ul>
      <div id="patch-panel" role="tabpanel" aria-labelledby={`tab-${tab.kind}`}>
        {tab.files.length > 0 && (
          <>
            {tab.files.map((f, i) => (
              <div className="file" key={`${f.from}-${f.path}-${i}`}>
                <p className="file-head">
                  <span className="url">{f.path}</span>
                  <span className="mini-msg">from {f.from}</span>
                </p>
                <Pre label={`Draft of ${f.path}`}>{f.content}</Pre>
              </div>
            ))}
            <CopyBtn onClick={() => onCopy(suggestedFilesBundle(tab.files), tab.label)}>Copy {tab.label}</CopyBtn>
          </>
        )}
      </div>
    </>
  );
}

function RecheckDrawer({ prompt, onCopy }: { prompt: string; onCopy: (t: string, w: string) => void }) {
  return (
    <>
      <p className="drawer-note">
        This schedules nothing and the server stores nothing. It copies a prompt for your AI that asks it to call snapshot-cloudflare-baseline again with the baseline below. Save it and paste it in about 7 days.
      </p>
      <Pre label="Re-check prompt">{prompt}</Pre>
      <CopyBtn onClick={() => onCopy(prompt, "the re-check prompt")}>Copy 7-day re-check prompt</CopyBtn>
    </>
  );
}
