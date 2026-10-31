import { readFileSync } from "node:fs";
import os from "node:os";
import type { Browser } from "puppeteer";
import { defaultLaunch } from "./submit.js";

function cgroupMemoryLimit(): string {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      /* not present on this platform */
    }
  }
  return "unknown";
}

/**
 * Launches Chromium once, opens about:blank, closes it, and logs the outcome. It never touches
 * Brave. Lets an operator confirm from the runtime logs that the browser works in this
 * environment before any real submission is attempted.
 */
export async function runBrowserSelfCheck(launch: () => Promise<Browser> = defaultLaunch): Promise<boolean> {
  const startedAt = Date.now();
  const env = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpus: os.availableParallelism(),
    totalMemMB: Math.round(os.totalmem() / 1048576),
    cgroupMemoryLimit: cgroupMemoryLimit(),
    sandbox: process.env.BRAVE_SUBMITTER_NO_SANDBOX === "1" ? "DISABLED (opt-in)" : "enabled",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "puppeteer default",
    uid: process.getuid?.(),
  };
  let browser: Browser | undefined;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.goto("about:blank");
    const version = await browser.version();
    console.log(JSON.stringify({ event: "browser-selfcheck", ok: true, version, ms: Date.now() - startedAt, ...env }));
    return true;
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).split("\n").slice(0, 3).join(" | ").slice(0, 600);
    console.log(JSON.stringify({ event: "browser-selfcheck", ok: false, reason, ms: Date.now() - startedAt, ...env }));
    return false;
  } finally {
    try {
      await browser?.close();
    } catch {
      browser?.process()?.kill("SIGKILL");
    }
  }
}
