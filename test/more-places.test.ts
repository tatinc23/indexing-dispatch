import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderMorePlacesPage, type MorePlacesData } from "../scripts/more-places.mjs";

const data = JSON.parse(readFileSync(new URL("../src/more-places.json", import.meta.url), "utf8")) as MorePlacesData;
const rows = () => data.groups.flatMap((g) => g.sites);

test("more-places data: every row has a name, an https submit URL, a tag and a check date", () => {
  assert.match(data.checked, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(rows().length > 0);
  for (const s of rows()) {
    assert.ok(s.name && typeof s.name === "string", "name");
    assert.ok(s.submitUrl?.startsWith("https://"), `${s.name}: submit URL is https`);
    assert.ok(s.tag && typeof s.tag === "string", `${s.name}: tag`);
    assert.match(s.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, `${s.name}: verifiedOn`);
  }
});

test("more-places page uses the letter-card shell (content never sits on the stripes)", () => {
  const html = renderMorePlacesPage(data, "https://dispatch.tatinc.us");
  assert.ok(html.includes('class="env-in"'), "env-in letter card");
  assert.ok(html.includes('class="envelope doc'), "envelope doc shell");
  assert.ok(html.includes('class="skip"'), "skip link");
});

test("more-places page lists exactly the data file's sites, every link https with nofollow", () => {
  const html = renderMorePlacesPage(data, "https://dispatch.tatinc.us");
  for (const s of rows()) {
    assert.ok(html.includes(s.name.replaceAll("&", "&amp;")), `page names ${s.name}`);
    assert.ok(html.includes(`href="${s.submitUrl}"`), `page links ${s.submitUrl}`);
  }
  const hrefs = [...html.matchAll(/href="(https?:[^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= rows().length);
  for (const h of hrefs) assert.ok(h.startsWith("https://"), `https link: ${h}`);
  assert.ok(html.includes('rel="nofollow noopener"'));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes(`Checked ${data.checked}`));
});
