// Deep-link builder for the "Add to Cursor" button. The config is the same
// JSON as mcp.json, base64-encoded, generated at build time from MCP_URL so
// source and built pages can never disagree about the server address.
export function cursorInstallLink(mcpUrl) {
  const config = Buffer.from(JSON.stringify({ url: mcpUrl })).toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=indexing-dispatch&config=${config}`;
}

export function decodeCursorLink(link) {
  const config = new URL(link).searchParams.get("config");
  return JSON.parse(Buffer.from(config, "base64").toString("utf8"));
}
