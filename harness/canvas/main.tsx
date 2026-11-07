// Harness entry. Query: ?cf=1 (Cloudflare enabled) &ps=1 (PageSpeed enabled) &urls=a,b,c &delay=ms &mode=autonomous
// &brave=mixed|accepted|rejected|error &viesearch=accepted|rejected|error &audit=findings|clean|unreachable &empty=1 (no URLs)
import { createRoot } from "react-dom/client";
import { Canvas } from "../../views/render-submission-canvas/Canvas.js";
import { normalizeProps } from "../../views/render-submission-canvas/lib.js";
import "../../views/render-submission-canvas/styles.css";
import { mockRunner } from "./mock-runner.js";

const q = new URLSearchParams(location.search);
const props = normalizeProps({
  initialUrls: q.get("empty") === "1" ? [] : (q.get("urls") ?? "https://example.com/,https://example.com/pricing,https://example.com/docs").split(",").filter(Boolean),
  mode: q.get("mode") ?? "interactive",
  enabledTools: { cloudflare: q.get("cf") === "1", pageSpeed: q.get("ps") === "1" },
  morePlacesUrl: "https://dispatch.tatinc.us/more-places",
});

createRoot(document.getElementById("root")!).render(
  <>
    <p style={{ margin: 0, padding: "6px 16px", background: "#3a2a00", color: "#f2cd8b", font: "13px system-ui" }}>
      Harness: every tool result below is MOCK data, not a real call.
    </p>
    <Canvas props={props} runner={mockRunner(Number(q.get("delay") ?? 500), {
      brave: (q.get("brave") as "mixed" | null) ?? undefined,
      viesearch: (q.get("viesearch") as "accepted" | null) ?? undefined,
      audit: (q.get("audit") as "findings" | null) ?? undefined,
    })} />
  </>,
);
