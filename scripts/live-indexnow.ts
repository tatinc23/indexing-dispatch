// ONE-OFF live IndexNow ping from this machine (the Cloudflare Worker's egress got HTTP 429, this Mac got 202).
// Usage: node --import tsx scripts/live-indexnow.ts <host> <key> <url> [<url> ...]   Sends ONE real request. Never loop it.
import { submitIndexNow } from "../src/indexnow.js";

const [host, key, ...urls] = process.argv.slice(2);
if (!host || !key || urls.length === 0) throw new Error("usage: live-indexnow.ts <host> <key> <url> [<url> ...]");
const result = await submitIndexNow({ host, key, urls });
console.log(JSON.stringify(result, null, 2));
