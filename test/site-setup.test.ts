import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cursorInstallLink, decodeCursorLink } from "../scripts/cursor-link.mjs";

const MCP_URL = "https://dispatch-mcp.tatinc.us/mcp";

test("cursor deep link decodes to { url: MCP_URL }", () => {
  assert.deepEqual(decodeCursorLink(cursorInstallLink(MCP_URL)), { url: MCP_URL });
});

test("cursor deep link tracks any server URL (build-time value, never hardcoded)", () => {
  const other = "https://example.com/mcp";
  assert.deepEqual(decodeCursorLink(cursorInstallLink(other)), { url: other });
});

test("cursor deep link carries the install scheme, name and config", () => {
  const link = cursorInstallLink(MCP_URL);
  assert.ok(link.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=indexing-dispatch&config="));
});

test("landing page wires the Add to Cursor button to the build-time link", () => {
  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  assert.ok(html.includes('href="{{CURSOR_LINK}}"'), "Add to Cursor href carries the {{CURSOR_LINK}} token");
});
