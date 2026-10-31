// ONE-OFF live run against the real Brave page. Usage: node --import tsx scripts/live-submit.ts <url>
// Prints each distinct page snapshot seen after clicking Submit, then the final tool result.
import { toToolResult } from "../src/format.js";
import { submitToBrave } from "../src/submit.js";

const target = process.argv[2];
if (!target) throw new Error("usage: live-submit.ts <url>");

let last = "";
const out = await submitToBrave(target, {
  onSnapshot: (snap, elapsed) => {
    const { bodyText, ...rest } = snap;
    const key = JSON.stringify(rest);
    if (key !== last) {
      last = key;
      console.log(`--- snapshot @${elapsed}ms ---\n${JSON.stringify({ ...rest, bodyText: bodyText.slice(0, 400) }, null, 2)}`);
    }
  },
});
const tool = toToolResult(out.result, out.screenshot);
console.log("=== FINAL RESULT ===");
console.log(JSON.stringify({ ...tool, content: tool.content.map((c) => (c.type === "image" ? { ...c, data: `<${c.data.length} chars>` } : c)) }, null, 2));
console.log("clicked:", out.clicked);
if (out.screenshot) {
  const { writeFileSync } = await import("node:fs");
  const path = `${process.env.TMPDIR ?? "/tmp"}/brave-live-final.jpg`;
  writeFileSync(path, Buffer.from(out.screenshot, "base64"));
  console.log("screenshot:", path);
}
