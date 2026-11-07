// MCP App view for the render-submission-canvas tool. Props arrive as the tool's structuredContent (CanvasProps);
// the four discovery tools are called through the host with useDynamicTool (works without the Register typing).
import { ToolError, useDynamicTool, useToolContext } from "mcp-use/react";
import type { AuditResult, CloudflareBaseline } from "../../src/contract.js";
import type { SubmitResult } from "../../src/schema.js";
import { Canvas, type Runner } from "./Canvas.js";
import { normalizeProps } from "./lib.js";
import "./styles.css";

function structured<T>(res: { structuredContent?: unknown }, tool: string): T {
  if (res.structuredContent === undefined || res.structuredContent === null) {
    throw new Error(`${tool} returned no structured result.`);
  }
  return res.structuredContent as T;
}

export default function RenderSubmissionCanvas() {
  const ctx = useToolContext();
  const brave = useDynamicTool<{ targetUrl: string }, SubmitResult>("submit-brave-url");
  const viesearch = useDynamicTool<{ targetUrl: string; contactEmail: string }, SubmitResult>("submit-viesearch-url");
  const audit = useDynamicTool<{ targetUrl: string; strategy?: "mobile" | "desktop" }, AuditResult>("audit-site");
  const cloudflare = useDynamicTool<{ zoneId: string; previous?: CloudflareBaseline }, CloudflareBaseline>("snapshot-cloudflare-baseline");

  if (ctx.status === "pending") {
    return (
      <div className="canvas">
        <p className="sub" role="status">
          Loading the canvas...
        </p>
      </div>
    );
  }
  if (ctx.status === "error") {
    return (
      <div className="canvas">
        <p className="err-text" role="alert">
          The canvas could not start: {ctx.error.message}
        </p>
      </div>
    );
  }

  const runner: Runner = {
    // submit-brave-url sets isError for every status except "accepted"; unwrap() still returns the structured result.
    async brave(args) {
      return unwrap<SubmitResult>(() => brave.callTool(args), "submit-brave-url");
    },
    async viesearch(args) {
      return unwrap<SubmitResult>(() => viesearch.callTool(args), "submit-viesearch-url");
    },
    async audit(args) {
      return unwrap<AuditResult>(() => audit.callTool(args), "audit-site");
    },
    async cloudflare(args) {
      return unwrap<CloudflareBaseline>(() => cloudflare.callTool(args), "snapshot-cloudflare-baseline");
    },
  };

  return <Canvas props={normalizeProps(ctx.toolOutput)} runner={runner} />;
}

/** Tools that report problems as structured results with isError still deliver that result. */
async function unwrap<T extends { status: string }>(call: () => Promise<{ structuredContent?: unknown }>, tool: string): Promise<T> {
  try {
    return structured<T>(await call(), tool);
  } catch (e) {
    if (e instanceof ToolError) {
      const sc = (e.result as { structuredContent?: unknown }).structuredContent as T | undefined;
      if (sc && typeof sc === "object" && "status" in sc) return sc;
    }
    throw e;
  }
}
