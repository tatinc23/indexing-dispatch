/**
 * Scripts that run INSIDE Brave's page. They are plain strings on purpose: a transpiler
 * (tsx/esbuild) can inject helper calls into serialized functions that do not exist in
 * the page context, so nothing here is compiled.
 */

/** Resolves to the URL input element (or null). Scores candidates; never takes "the first input". */
export const FIND_URL_INPUT = `(() => {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const labelText = (e) =>
    (Array.from(e.labels || []).map((l) => l.textContent).join(' ') + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase();
  const candidates = Array.from(document.querySelectorAll('input')).filter((e) => {
    const type = (e.getAttribute('type') || 'text').toLowerCase();
    return visible(e) && !e.disabled && !e.readOnly && ['text', 'url', 'search'].includes(type);
  });
  let best = null, bestScore = 0, tie = false;
  for (const e of candidates) {
    let score = 0;
    if ((e.getAttribute('autocomplete') || '').toLowerCase() === 'url') score += 3;
    if (/^(url|link|website)$/i.test(e.id || '') || /^(url|link|website)$/i.test(e.name || '')) score += 3;
    if ((e.getAttribute('type') || '').toLowerCase() === 'url') score += 2;
    if (/url|link|website|http/i.test(e.placeholder || '')) score += 2;
    if (/url|link|website/.test(labelText(e))) score += 2;
    if (score > bestScore) { best = e; bestScore = score; tie = false; }
    else if (score === bestScore && score > 0) tie = true;
  }
  return best && bestScore >= 2 && !tie ? best : null;
})()`;

/** Resolves to the visible button/input whose text is exactly "Submit" (so a "Submitted" button never matches). */
export const FIND_SUBMIT_BUTTON = `(() => {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const label = (e) => (e.tagName === 'INPUT' ? e.value : e.textContent || '').trim();
  const matches = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]'))
    .filter((e) => visible(e) && /^submit$/i.test(label(e)));
  return matches.length === 1 ? matches[0] : null;
})()`;

/** Finds Viesearch's contact-email input: type=email first, then name/id/placeholder/label matches. Never matches hidden inputs. */
export const FIND_EMAIL_INPUT = `(() => {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const fields = Array.from(document.querySelectorAll('input')).filter(visible);
  const score = (e) => {
    let s = 0;
    const type = (e.type || '').toLowerCase();
    const auto = (e.getAttribute('autocomplete') || '').toLowerCase();
    const attrs = ((e.name || '') + ' ' + (e.id || '') + ' ' + (e.placeholder || '')).toLowerCase();
    const labels = Array.from(document.querySelectorAll('label'))
      .filter((l) => !l.control || l.control === e)
      .map((l) => (l.textContent || '').toLowerCase())
      .join(' ');
    if (type === 'email') s += 4;
    if (auto === 'email') s += 3;
    if (/(^|[^a-z])e-?mails?([^a-z]|$)/.test(attrs + ' ' + labels)) s += 3;
    if (type === 'hidden') s -= 10;
    return s;
  };
  let best = null;
  let bestScore = 0;
  for (const e of fields) {
    const s = score(e);
    if (s > bestScore) { best = e; bestScore = s; }
  }
  return best;
})()`;

/** Reads the facts the classifier needs. Pure observation: never mutates the page. */
export const READ_SNAPSHOT = `(() => {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const label = (e) => clean(e.tagName === 'INPUT' ? e.value : e.textContent);

  const buttons = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]'))
    .filter(visible)
    .map((e) => ({ text: label(e).slice(0, 60), disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true' }));

  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'))
    .filter(visible)
    .map((e) => clean(e.textContent).slice(0, 80));

  const isAlertish = (e) =>
    e.getAttribute('role') === 'alert' ||
    e.getAttribute('aria-live') === 'assertive' ||
    /(^|[\\s_-])(error|invalid|danger|alert)([\\s_-]|$)/i.test((e.className && e.className.baseVal === undefined ? e.className : '') + ' ' + (e.id || ''));
  const alerts = Array.from(document.querySelectorAll('[role=alert], [aria-live], [class], [id]'))
    .filter((e) => isAlertish(e) && visible(e))
    .map((e) => ({ text: clean(e.textContent).slice(0, 300), role: e.getAttribute('role') || '', explicitError: /(^|[\\s_-])(error|invalid|danger)([\\s_-]|$)/i.test((typeof e.className === 'string' ? e.className : '') + ' ' + (e.id || '')) }))
    .filter((a) => a.text.length > 0)
    .slice(0, 6);

  const input = document.querySelector('input#url, input[autocomplete=url]');
  const inputInvalid = !!input && input.getAttribute('aria-invalid') === 'true';

  // Confirmation: deepest visible element containing the exact message, plus its compact region.
  const MESSAGE = /thank you for your submission/i;
  let message = null;
  for (const e of Array.from(document.querySelectorAll('body *'))) {
    if (!visible(e) || !MESSAGE.test(e.textContent || '')) continue;
    const deeper = Array.from(e.children).some((c) => MESSAGE.test(c.textContent || ''));
    if (!deeper) { message = e; break; }
  }
  let confirmation = null;
  if (message) {
    // Look for a "Success" label near the message (Brave renders it as a plain element, not a heading tag).
    let scope = message;
    for (let i = 0; i < 3 && scope.parentElement && scope.parentElement !== document.body; i++) {
      if (clean(scope.parentElement.textContent).length > 300) break;
      scope = scope.parentElement;
    }
    const success = Array.from(scope.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],strong,b,p,span,div'))
      .find((e) => visible(e) && /^success!?$/i.test(clean(e.textContent)));
    // Region = lowest common ancestor of the message and the Success label, so unrelated form text stays out.
    let region = message;
    if (success) {
      while (region && !region.contains(success)) region = region.parentElement;
    }
    confirmation = {
      messageText: clean(message.innerText).slice(0, 200),
      regionText: clean((region || message).innerText).slice(0, 300),
      hasSuccessHeading: !!success,
    };
  }

  const challengeFrames = Array.from(document.querySelectorAll('iframe'))
    .filter((f) => { const r = f.getBoundingClientRect(); return visible(f) && r.width >= 30 && r.height >= 30; })
    .map((f) => { try { return new URL(f.src, location.href).hostname; } catch (_) { return ''; } })
    .filter((h) => /(hcaptcha|recaptcha|google\\.com|gstatic|challenges\\.cloudflare|turnstile|captcha|arkoselabs|funcaptcha)/i.test(h));
  const bodyText = clean(document.body ? document.body.innerText : '');
  const CHALLENGE_TEXT = /(i['’]?m not a robot|verify (that )?you['’]?re (a )?human|verify you are (a )?human|complete the (captcha|challenge|puzzle|security check)|solve the (captcha|puzzle)|select all (images|squares)|press and hold)/i;
  const challengeText = (bodyText.match(CHALLENGE_TEXT) || [null])[0];

  return {
    url: location.href,
    buttons,
    headings,
    alerts,
    inputInvalid,
    confirmation,
    challenge: { frames: challengeFrames.slice(0, 3), text: challengeText },
    bodyText: bodyText.slice(0, 1500),
  };
})()`;

/**
 * Viesearch twin of READ_SNAPSHOT. Identical except the confirmation wording below, which is
 * PROVISIONAL: the submit form was read live on 2026-11-07 but no real submission has been
 * observed yet, so the success text is a guess. Accepting still needs corroboration (a Success
 * heading or a submitted-state button) exactly like the Brave flow, and the first real
 * submission (done by hand) must replace this guess with the observed page. See classify.ts
 * and docs/directories-2026-11-07.md ("Viesearch" row).
 */
export const READ_VIESEARCH_SNAPSHOT = `(() => {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const label = (e) => clean(e.tagName === 'INPUT' ? e.value : e.textContent);

  const buttons = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]'))
    .filter(visible)
    .map((e) => ({ text: label(e).slice(0, 60), disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true' }));

  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'))
    .filter(visible)
    .map((e) => clean(e.textContent).slice(0, 80));

  const isAlertish = (e) =>
    e.getAttribute('role') === 'alert' ||
    e.getAttribute('aria-live') === 'assertive' ||
    /(^|[\\s_-])(error|invalid|danger|alert)([\\s_-]|$)/i.test((e.className && e.className.baseVal === undefined ? e.className : '') + ' ' + (e.id || ''));
  const alerts = Array.from(document.querySelectorAll('[role=alert], [aria-live], [class], [id]'))
    .filter((e) => isAlertish(e) && visible(e))
    .map((e) => ({ text: clean(e.textContent).slice(0, 300), role: e.getAttribute('role') || '', explicitError: /(^|[\\s_-])(error|invalid|danger)([\\s_-]|$)/i.test((typeof e.className === 'string' ? e.className : '') + ' ' + (e.id || '')) }))
    .filter((a) => a.text.length > 0)
    .slice(0, 6);

  const urlInput = document.querySelector('input#url, input[autocomplete=url]');
  const emailInput = document.querySelector('input[type=email], input[name=email], input[name*=email i]');
  const bad = [urlInput, emailInput].find((i) => !!i && i.getAttribute('aria-invalid') === 'true');
  const inputInvalid = !!bad;

  // Provisional confirmation wording (see the comment on READ_VIESEARCH_SNAPSHOT): deepest visible
  // element carrying explicit thanks/success/submission wording, plus its compact region.
  const MESSAGE = /(thank\\s+you[^.]{0,160}|success[^.]{0,160}|successfully submitted[^.]{0,160}|has been submitted[^.]{0,160}|received[^.]{0,160}|under review[^.]{0,160})/i;
  let message = null;
  for (const e of Array.from(document.querySelectorAll('body *'))) {
    if (!visible(e) || !MESSAGE.test(e.textContent || '')) continue;
    const deeper = Array.from(e.children).some((c) => MESSAGE.test(c.textContent || ''));
    if (!deeper) { message = e; break; }
  }
  let confirmation = null;
  if (message) {
    let scope = message;
    for (let i = 0; i < 3 && scope.parentElement && scope.parentElement !== document.body; i++) {
      if (clean(scope.parentElement.textContent).length > 300) break;
      scope = scope.parentElement;
    }
    const success = Array.from(scope.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],strong,b,p,span,div'))
      .find((e) => visible(e) && /^success!?$/i.test(clean(e.textContent)));
    let region = message;
    if (success) {
      while (region && !region.contains(success)) region = region.parentElement;
    }
    confirmation = {
      messageText: clean(message.innerText).slice(0, 200),
      regionText: clean((region || message).innerText).slice(0, 300),
      hasSuccessHeading: !!success,
    };
  }

  const challengeFrames = Array.from(document.querySelectorAll('iframe'))
    .filter((f) => { const r = f.getBoundingClientRect(); return visible(f) && r.width >= 30 && r.height >= 30; })
    .map((f) => { try { return new URL(f.src, location.href).hostname; } catch (_) { return ''; } })
    .filter((h) => /(hcaptcha|recaptcha|google\\.com|gstatic|challenges\\.cloudflare|turnstile|captcha|arkoselabs|funcaptcha)/i.test(h));
  const bodyText = clean(document.body ? document.body.innerText : '');
  const CHALLENGE_TEXT = /(i['’]?m not a robot|verify (that )?you['’]?re (a )?human|verify you are (a )?human|complete the (captcha|challenge|puzzle|security check)|solve the (captcha|puzzle)|select all (images|squares)|press and hold)/i;
  const challengeText = (bodyText.match(CHALLENGE_TEXT) || [null])[0];

  return {
    url: location.href,
    buttons,
    headings,
    alerts,
    inputInvalid,
    confirmation,
    challenge: { frames: challengeFrames.slice(0, 3), text: challengeText },
    bodyText: bodyText.slice(0, 1500),
  };
})()`;
