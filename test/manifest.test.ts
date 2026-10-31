import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SERVER_INFO,
  WIDGET_ORIGIN,
  auditSiteDef,
  renderSubmissionCanvasDef,
  submitBraveUrlDef,
  submitIndexnowDef,
  toolInvocationMeta,
} from "../src/tool-defs.js";

const manifest = JSON.parse(readFileSync(new URL("../site/mcp.json", import.meta.url), "utf8"));
const defs = [submitBraveUrlDef, auditSiteDef, submitIndexnowDef, renderSubmissionCanvasDef];

test("mcp.json lists exactly the tools the server registers", () => {
  assert.deepEqual([...manifest.tools].sort(), defs.map((d) => d.name).sort());
});

test("mcp.json points at the MCP endpoint in every shape and needs no auth", () => {
  assert.equal(manifest.url, "{{MCP_URL}}");
  assert.equal(manifest.remotes[0].url, "{{MCP_URL}}");
  assert.equal(manifest.mcpServers["brave-submitter"].url, "{{MCP_URL}}");
  assert.equal(manifest.authentication, "none");
});

test("server website is the public page, not Brave's", () => {
  assert.equal(SERVER_INFO.websiteUrl, "https://dispatch.tatinc.us");
});

test("every tool carries ChatGPT invocation labels within OpenAI's 64-character limit", () => {
  for (const d of defs) {
    const m = d._meta as Record<string, unknown>;
    const invoking = m["openai/toolInvocation/invoking"] as string;
    const invoked = m["openai/toolInvocation/invoked"] as string;
    assert.ok(invoking && invoking.length <= 64, `${d.name} invoking`);
    assert.ok(invoked && invoked.length <= 64, `${d.name} invoked`);
    assert.deepEqual(m["openai/toolInvocation"], { invoking, invoked });
  }
  assert.deepEqual(toolInvocationMeta("a", "b")["openai/toolInvocation"], { invoking: "a", invoked: "b" });
});

test("canvas view declares one exact https origin", () => {
  assert.equal(renderSubmissionCanvasDef.view.domain, WIDGET_ORIGIN);
  assert.match(WIDGET_ORIGIN, /^https:\/\/[a-z0-9.-]+$/);
});
