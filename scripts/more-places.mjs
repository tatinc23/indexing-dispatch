// Renders the static /more-places page from src/more-places.json at site build time.
// Plain Node, no dependencies, importable by tests (no side effects on import).
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function renderMorePlacesPage(data, siteUrl) {
  const groups = data.groups
    .map((g) => {
      const rows = g.sites
        .map(
          (s) =>
            `<li><a href="${esc(s.submitUrl)}" rel="nofollow noopener" target="_blank">${esc(s.name)}</a> <span class="tag">${esc(s.tag)}</span>${s.note ? `<span class="note">${esc(s.note)}</span>` : ""}</li>`,
        )
        .join("\n      ");
      return `    <section aria-label="${esc(g.title)}">\n      <h2>${esc(g.title)}</h2>\n      <ul class="dots">\n      ${rows}\n      </ul>\n    </section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>More places to submit yourself | Indexing Dispatch</title>
<meta name="description" content="Directories worth being on that no agent can submit to: they need a sign-up, a CAPTCHA, or their rules say no. Submit to them yourself, with their own submit links.">
<link rel="canonical" href="${esc(siteUrl)}/more-places">
<link rel="stylesheet" href="css/site.css">
</head>
<body id="top">
<main id="main">
<section class="envelope" aria-labelledby="title">
  <h1 id="title">More places to submit yourself</h1>
  <p class="big">These sites are worth being on, but they don&rsquo;t let an agent submit for you: they need a sign-up, a CAPTCHA, or their rules say no. Submit to them yourself.</p>
  <p class="tiny">Checked ${esc(data.checked)}. Links open in a new tab and carry no referral.</p>
${groups}
  <p class="tiny"><a href="/">Back to Indexing Dispatch</a></p>
</section>
</main>
</body>
</html>
`;
}
