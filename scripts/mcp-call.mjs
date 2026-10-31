// Minimal MCP client for testing this server over streamable HTTP (local or remote).
//   node scripts/mcp-call.mjs <mcp-url> list
//   node scripts/mcp-call.mjs <mcp-url> call submit-brave-url '{"targetUrl":"https://example.com"}'
//   node scripts/mcp-call.mjs <mcp-url> resources            (lists resources, e.g. the canvas view)
//   node scripts/mcp-call.mjs <mcp-url> read <resource-uri>   (reads one; long text is summarised)
// Auth: set MCP_BEARER in the environment (never pass keys as arguments). Image data is elided in output.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const [url, command, toolName, rawArgs] = process.argv.slice(2);
if (!url || !["list", "call", "resources", "read"].includes(command)) {
  console.error("usage: mcp-call.mjs <mcp-url> list | call <tool> '<json-args>' | resources | read <uri>");
  process.exit(2);
}

const headers = process.env.MCP_BEARER ? { authorization: `Bearer ${process.env.MCP_BEARER}` } : {};
const client = new Client({ name: "brave-submitter-test", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });

const elide = (v) =>
  JSON.parse(JSON.stringify(v, (k, val) => (k === "data" && typeof val === "string" && val.length > 200 ? `<${val.length} chars elided>` : val)));

try {
  await client.connect(transport);
  if (command === "list") {
    const { tools } = await client.listTools();
    console.log(JSON.stringify(elide(tools), null, 2));
  } else if (command === "resources") {
    console.log(JSON.stringify(await client.listResources(), null, 2));
  } else if (command === "read") {
    const { contents } = await client.readResource({ uri: toolName });
    const summary = contents.map((c) => ({ uri: c.uri, mimeType: c.mimeType, _meta: c._meta, textLength: c.text?.length, textStart: c.text?.slice(0, 300) }));
    console.log(JSON.stringify(summary, null, 2));
  } else {
    // Default SDK timeout is 60 s; a cold browser submission can take up to ~80 s.
    const result = await client.callTool({ name: toolName, arguments: rawArgs ? JSON.parse(rawArgs) : {} }, { timeout: 120_000 });
    console.log(JSON.stringify(elide(result), null, 2));
  }
} catch (e) {
  console.log(JSON.stringify({ transportOrProtocolError: e instanceof Error ? e.message : String(e) }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
