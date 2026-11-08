// Renders the static /more-places page from src/more-places.json at site build time.
// Plain Node, no dependencies, importable by tests (no side effects on import).
// Shell is an exact copy of site/privacy.html (skip link, favicons, envelope doc,
// env-in letter card, ret header, footer): content must never sit on the stripes.
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="633.1 595.1 859.6 859.6" class="logo" aria-hidden="true" focusable="false"><path fill="#13203F" d="M 693.61 646.984 L 992.653 646.976 C 992.435 675.653 992.386 704.331 992.507 733.008 L 783.459 733.027 C 782.148 796.596 783.355 864.286 783.325 928.276 L 783.202 1317.74 L 866.5 1317.94 L 992.764 1317.91 L 992.472 1402.75 L 693.702 1402.87 L 693.61 646.984 z"/><path fill="#2f7a1f" d="M 1159.12 756.668 C 1165.38 759.515 1226.23 821.865 1235.82 831.345 L 1432.29 1025.3 C 1422.4 1034.33 1412.54 1043.5 1403.18 1053.09 C 1323.67 1134.51 1240.12 1212.98 1161.24 1294.91 C 1139.02 1272.51 1116.71 1252.53 1094.1 1230.75 C 1105.43 1218.94 1120.29 1205.42 1132.25 1193.85 L 1187.69 1139.44 C 1210.9 1117.17 1234.45 1093.78 1257.26 1071.12 L 896.961 1070.94 L 896.976 978.417 L 1258.4 978.595 C 1245.7 963.877 1221.18 942.394 1206.17 927.669 C 1169.45 891.638 1131.25 856.373 1094.59 820.233 C 1115.36 798.937 1137.81 777.623 1159.12 756.668 z"/></svg>`;

export function renderMorePlacesPage(data, siteUrl) {
  const groups = data.groups
    .map((g) => {
      const rows = g.sites
        .map(
          (s) =>
            `<li><a href="${esc(s.submitUrl)}" rel="nofollow noopener" target="_blank">${esc(s.name)}</a> <span class="tag">${esc(s.tag)}</span>${s.note ? `<details class="mp-why"><summary aria-label="Why submitting to ${esc(s.name)} needs you">i</summary><span class="mp-note">${esc(s.note)}</span></details>` : ""}</li>`,
        )
        .join("\n      ");
      return `    <section class="mp-group" aria-label="${esc(g.title)}">\n      <h2>${esc(g.title)}</h2>\n      <ul class="dots">\n      ${rows}\n      </ul>\n    </section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>More places to submit yourself | Indexing Dispatch</title>
<meta name="description" content="Directories worth being on that no agent can submit to: they need a sign-up, a CAPTCHA, or their rules say no. Submit to them yourself, with their own submit links.">
<meta name="theme-color" content="#E8ECF4">
<meta name="color-scheme" content="light">
<link rel="canonical" href="${esc(siteUrl)}/more-places">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="icon" href="favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="favicon-180.png">
<link rel="stylesheet" href="css/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<main id="main">
<section class="envelope doc mp" aria-labelledby="doc-h">
  <div class="env-in">
    <header class="ret">
      <a class="mark" href="./">${LOGO}<span>Indexing Dispatch</span></a>
    </header>

  <h1 id="doc-h">More places to submit yourself</h1>
  <p class="big">These sites are worth being on, but they don&rsquo;t let an agent submit for you: they need a sign-up, a CAPTCHA, or their rules say no. Submit to them yourself.</p>
  <p class="tiny">Starting list from <a href="https://x.com/wespreadjam/status/2115501442970857949" rel="nofollow noopener" target="_blank">@wespreadjam</a>. Checked ${esc(data.checked)} against each site&rsquo;s own submit page and terms. Links open in a new tab and carry no referral.</p>

  <div class="mp-groups">
${groups}
  </div>
    <p><a class="back" href="./">Back to Indexing Dispatch</a></p>
  </div>
</section>
</main>

<footer class="foot">
  <div class="airmail" aria-hidden="true"></div>
  <div class="foot-row">
    <p>Indexing Dispatch by <a href="https://tatinc.us/">TAT Inc</a>. Free forever. Not affiliated with Brave.</p>
    <nav aria-label="Footer">
      <a href="privacy">Privacy</a>
      <a href="terms">Terms</a>
      <a href="https://github.com/tatinc23/indexing-dispatch">Source code</a>
      <a href="mailto:emailme@tatinc.us">emailme@tatinc.us</a>
    </nav>
  </div>
  <p class="motto">The future belongs to those who play.</p>
</footer>
</body>
</html>
`;
}
