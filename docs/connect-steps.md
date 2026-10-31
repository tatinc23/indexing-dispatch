# Connect brave-submitter to your AI app

Server URL (streamable HTTP, no sign-in): `https://dispatch-mcp.tatinc.us/mcp`

Re-verified 2026-10-27 against each vendor's current official docs (sources below). These are manual "add a custom server" steps: brave-submitter is not listed in any app's directory or marketplace.

## Claude (claude.ai, Claude Desktop)
Source: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
1. **Customize > Connectors**.
2. **+ Add**, then **Add custom connector**.
3. Name: `brave-submitter`. URL: the server URL above. **Continue**.
4. **Authentication: No sign in**. **Add**.
5. In a chat: **+** (lower left) > **Connectors** > switch **brave-submitter** on.
Every plan can add custom connectors; Free is limited to one. Team/Enterprise: an Owner adds it under **Organization settings > Connectors**, members click **Connect**. Claude Code (not covered by that article): `claude mcp add --transport http brave-submitter <server URL>`.

## Codex (ChatGPT desktop app, Codex IDE extension, Codex CLI)
Source: https://learn.chatgpt.com/docs/extend/mcp (developers.openai.com/codex/mcp redirects here). The desktop app, CLI and IDE extension share one MCP config.
- **Desktop app:** **Settings > MCP servers > Add server**, name `brave-submitter`, choose **Streamable HTTP**, enter the URL, save, **Restart**. Type `/mcp` in the composer to see connected servers.
- **IDE extension:** gear menu > **MCP servers > Add server**, same fields, save, **Restart extension**.
- **CLI:** `codex mcp add brave-submitter --url <server URL>`, then `codex mcp list`. (The docs show `--url` only in an OAuth example; the flag itself is documented, a plain no-auth example is not.)
- **Config file** `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):
  ```toml
  [mcp_servers.brave-submitter]
  url = "https://dispatch-mcp.tatinc.us/mcp"
  ```
- No sign-in needed: "If no credential source resolves, Codex can connect to the server without authentication."

## Cursor
Source: https://cursor.com/docs/context/mcp
- Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):
  ```json
  { "mcpServers": { "brave-submitter": { "url": "https://dispatch-mcp.tatinc.us/mcp" } } }
  ```
- Cursor's docs say servers are installed and turned on/off from the **Customize** page in the sidebar. They do NOT document a click path for adding a server by URL, so use mcp.json. (Third-party guides mention Settings > Tools & Integrations > MCP; unverified, left out.) The Cursor Marketplace and cursor.directory are separate listings; brave-submitter is in neither.

## ChatGPT (web only)
Source: OpenAI Help Center, "Connecting custom MCP servers in ChatGPT" (help.openai.com/en/articles/12584461; blocks plain fetches, read in a browser 2026-10-27).
Who: custom MCP servers work on ChatGPT **Business** and **Enterprise/Edu**, on ChatGPT **web** only ("Can I connect custom MCP servers on mobile? No - web only"). Business: only admins and owners can create them (Workspace settings > Members shows who). Enterprise/Edu: admins/owners, plus members an admin authorizes. Pro users "can connect custom MCP servers with read/fetch permissions" only; brave-submitter submits a form, so it is not read-only. The page says nothing about Plus or Free.
Steps (no Developer Mode needed):
1. **Plugins**.
2. Select the plus button, then **Add custom MCP server**.
3. Enter a name (description optional).
4. Under **Connection**, paste the server URL.
5. **Authentication:** leave it off / none (the exact label is not on the help page).
6. Tick **I understand and want to continue** on the risk warning.
7. **Create as a plugin**, review the discovered tools.
8. Install the plugin, start a new chat, type `@` and pick it.
