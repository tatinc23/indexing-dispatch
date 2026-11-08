// Page helper: fills the page address into the prompts and copies them, marks which step you're on,
// opens the "More" sections from links, and plays the "How it works" postcards.
// Without JS the prompts are plain selectable text and these controls stay hidden.
// All copied text comes from the DOM, so the build's URL substitutions are what gets copied.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- toast ----
  var toast = $("toast");
  var toastText = $("toast-text");
  var toastTimer;
  function say(msg) {
    if (!toast || !toastText) return;
    toast.classList.remove("show");
    toastText.textContent = "";
    // Re-set the text on the next frame so screen readers announce repeats.
    window.requestAnimationFrame(function () {
      toastText.textContent = msg;
      toast.classList.add("show");
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 3500);
  }

  // ---- copy ----
  function selectNode(el) {
    var r = document.createRange();
    r.selectNodeContents(el);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  function legacyCopy(el) {
    selectNode(el);
    try { return document.execCommand("copy"); } catch (e) { return false; }
  }
  // Resolves true if copied, false if the text was only selected for a manual copy.
  function copyEl(el) {
    var text = el.textContent;
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(el); });
    }
    return Promise.resolve(legacyCopy(el));
  }

  // ---- the route: which step you're on, which are done ----
  var stops = [$("stop-1"), $("stop-2"), $("stop-3")];
  var now = 1;
  function setNow(n) {
    now = n;
    each(stops, function (s, i) { if (s) s.classList.toggle("is-now", i === n - 1); });
  }
  function markDone(n) {
    var s = stops[n - 1];
    if (s) s.classList.add("is-done");
  }

  // ---- step 1: copy the server address ----
  var addrNote = $("addr-note");
  each(document.querySelectorAll(".btn[data-copy]"), function (b) {
    var target = $(b.getAttribute("data-copy"));
    if (!target) return;
    b.hidden = false;
    var label = b.lastChild;
    var LABEL = label.textContent;
    var NOTE = addrNote ? addrNote.textContent : "";
    var t;
    b.addEventListener("click", function () {
      copyEl(target).then(function (ok) {
        if (!ok) { selectNode(target); say("Selected. Press Ctrl+C or Cmd+C to copy."); return; }
        label.textContent = "Copied";
        b.classList.add("done");
        if (addrNote) addrNote.textContent = b.getAttribute("data-done") || NOTE;
        say("Address copied");
        markDone(1);
        if (now === 1) setNow(2);
        clearTimeout(t);
        t = setTimeout(function () { label.textContent = LABEL; b.classList.remove("done"); }, 2500);
      });
    });
  });

  // ---- steps 2+3: the link, the Viesearch email, and the prompt form ----
  var slots = document.querySelectorAll(".slot");
  var eslots = document.querySelectorAll(".eslot");
  var form = $("go");
  var input = $("page-url");
  var hint = $("url-hint");
  var emailInput = $("contact-email");
  var emailHint = $("email-hint");
  var next = $("next");
  var peek = $("peek");
  var cap = $("prompt-cap");
  var prompts = document.querySelectorAll(".prompt[data-variant]");
  var PLACEHOLDER = slots.length ? slots[0].textContent : "";
  var EPLACEHOLDER = eslots.length ? eslots[0].textContent : "";
  var HINT = hint ? hint.textContent : "";
  var EHINT = emailHint ? emailHint.textContent : "";
  var NEXT = next ? next.innerHTML : "";
  var BAD = "That doesn't look like a web address yet, e.g. yourbusiness.com";
  var EBAD = "That email doesn't look complete. Check it, or leave it empty and use Just send to Brave.";

  function normalise(v) {
    v = v.trim();
    if (!v) return "";
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = "https://" + v;
    try {
      var u = new URL(v);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname.indexOf(".") > 0) return u.href;
    } catch (e) {}
    return null;
  }
  function setSlots(text, filled) {
    each(slots, function (s) {
      s.textContent = text;
      s.classList.toggle("filled", filled);
    });
  }
  function setHint(msg, bad) {
    hint.textContent = msg;
    hint.classList.toggle("bad", bad);
    if (bad) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
  function emailOk(v) {
    v = v.trim();
    if (!v) return true; // optional: empty means the Brave-only prompt still works
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
  }
  function setEslots(text, filled) {
    each(eslots, function (s) {
      s.textContent = text;
      s.classList.toggle("filled", filled);
    });
  }
  function setEmailHint(msg, bad) {
    if (!emailHint) return;
    emailHint.textContent = msg;
    emailHint.classList.toggle("bad", bad);
    if (!emailInput) return;
    if (bad) emailInput.setAttribute("aria-invalid", "true");
    else emailInput.removeAttribute("aria-invalid");
  }
  function currentPrompt() {
    var picked = form ? form.querySelector('input[name="what"]:checked') : null;
    var want = picked ? picked.value : "both";
    var found = null;
    each(prompts, function (p) { if (p.getAttribute("data-variant") === want) found = p; });
    return found || prompts[0];
  }
  function resetNext() {
    if (!next) return;
    next.innerHTML = NEXT;
    next.classList.remove("ok");
  }
  function showVariant() {
    var cur = currentPrompt();
    each(prompts, function (p) { p.hidden = p !== cur; });
    if (cap && cur) cap.textContent = cur.getAttribute("data-cap");
    resetNext();
  }

  if (form && input && hint && slots.length && prompts.length) {
    form.hidden = false;
    if (peek) peek.removeAttribute("open");
    showVariant();
    input.addEventListener("focus", function () { if (now === 1) setNow(2); });
    input.addEventListener("input", function () {
      var v = normalise(input.value);
      resetNext();
      if (v) {
        setSlots(v, true); setHint(HINT, false);
        markDone(2);
        if (now !== 3) setNow(3);
      } else {
        setSlots(PLACEHOLDER, false); setHint(v === null ? BAD : HINT, v === null);
        if (now !== 2) setNow(2);
      }
    });
    if (emailInput) {
      emailInput.addEventListener("focus", function () { if (now === 2) setNow(3); });
      emailInput.addEventListener("input", function () {
        var raw = emailInput.value.trim();
        resetNext();
        if (now !== 3) setNow(3);
        if (!raw) { setEslots(EPLACEHOLDER, false); setEmailHint(EHINT, false); }
        else if (emailOk(raw)) { setEslots(raw, true); setEmailHint(EHINT, false); }
        else { setEslots(EPLACEHOLDER, false); setEmailHint(EBAD, true); }
      });
    }
    each(form.querySelectorAll('input[name="what"]'), function (r) { r.addEventListener("change", showVariant); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = normalise(input.value);
      if (!v) {
        setHint(v === null ? BAD : "Add your website link first, then copy.", true);
        input.focus();
        return;
      }
      setSlots(v, true);
      var target = currentPrompt();
      var want = target.getAttribute("data-variant");
      // The email is optional: empty still copies, and the Brave-only prompt never mentions it.
      if (emailInput && want !== "brave") {
        var raw = emailInput.value.trim();
        if (raw && !emailOk(raw)) {
          setEmailHint(EBAD, true);
          emailInput.focus();
          return;
        }
        setEslots(raw || EPLACEHOLDER, !!raw);
        setEmailHint(raw ? EHINT : EHINT, false);
      }
      copyEl(target).then(function (ok) {
        if (ok) {
          say("Prompt copied");
          next.innerHTML = "Copied. Now paste it in your AI and send it. Not set up yet? <a href=\"#connect\">Do step 1 first</a>.";
          next.classList.add("ok");
          markDone(2);
          markDone(3);
        } else {
          if (peek) peek.setAttribute("open", "");
          selectNode(target);
          say("Selected. Press Ctrl+C or Cmd+C to copy.");
        }
      });
    });
  }

  // ---- small copy buttons for the config snippets ----
  each(document.querySelectorAll(".copy-snip[data-copy]"), function (b) {
    var target = $(b.getAttribute("data-copy"));
    if (!target) return;
    b.hidden = false;
    var t;
    b.addEventListener("click", function () {
      copyEl(target).then(function (ok) {
        b.textContent = ok ? "Copied" : "Press Ctrl+C";
        b.classList.toggle("done", ok);
        if (ok) say("Copied");
        else { selectNode(target); say("Selected. Press Ctrl+C or Cmd+C to copy."); }
        clearTimeout(t);
        t = setTimeout(function () { b.textContent = "Copy"; b.classList.remove("done"); }, 2500);
      });
    });
  });

  // ---- links into closed <details>: open every enclosing one, then go there ----
  function reveal(el) {
    for (var p = el; p; p = p.parentElement) if (p.tagName === "DETAILS") p.open = true;
  }
  function goTo(id, push) {
    var el = $(id);
    if (!el) return false;
    reveal(el);
    var focusEl = el.tagName === "DETAILS" ? el.querySelector("summary") : el;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    if (focusEl) {
      if (!focusEl.hasAttribute("tabindex") && !/^(SUMMARY|A|BUTTON|INPUT)$/.test(focusEl.tagName)) focusEl.setAttribute("tabindex", "-1");
      focusEl.focus({ preventScroll: true });
    }
    if (push && history.pushState) history.pushState(null, "", "#" + id);
    return true;
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var id = a.getAttribute("href").slice(1);
    if (!id || id === "top" || id === "main") return;
    if (goTo(id, true)) e.preventDefault();
  });
  if (location.hash.length > 1) goTo(decodeURIComponent(location.hash.slice(1)), false);
  window.addEventListener("hashchange", function () { if (location.hash.length > 1) goTo(decodeURIComponent(location.hash.slice(1)), false); });

  // ---- How it works: three postcards. The active one plays; the others rest on their last frame. ----
  var stage = $("stage");
  var playBtn = $("tour-play");
  if (!stage || !playBtn) return;
  var cards = stage.querySelectorAll(".pc");
  var capBtns = stage.querySelectorAll(".pc-cap[data-go]");
  var cursor = stage.querySelector(".cursor");
  var q = function (sel) { return stage.querySelector(sel); };
  var START = [0, 5000, 10000];
  var LOOP = 19500;
  var MAX_LOOPS = 3; // then every card rests on its last frame and the page goes quiet
  var END = 1e9;     // "local time" that means: show the finished frame
  var t = 0, loops = 0, last = 0, raf = 0;
  var userPaused = reduceMotion, onScreen = true;
  var pinned = 0;    // card picked while paused (highlighted, shown finished)

  var el = {
    s1type: q(".s1 .type"), add: q('.s1 [data-hit="1"]'), conn: q(".s1 .conn"), sw: q(".s1 .sw"),
    s2type: q(".s2 .type"), copy: q('.s2 [data-hit="2"]'), mslot: q(".s2 .mslot"),
    s3type: q(".s3 .composer .type"), send: q('.s3 [data-hit="3"]'), me: q(".s3 .bub.me"), t1: q(".s3 .t1"), t2: q(".s3 .t2"), t3: q(".s3 .t3"), ai: q(".s3 .bub.ai")
  };

  function typeInto(node, lt) {
    var full = node.getAttribute("data-type");
    var from = +node.getAttribute("data-from"), to = +node.getAttribute("data-to");
    var k = lt <= from ? 0 : lt >= to ? 1 : (lt - from) / (to - from);
    var txt = full.slice(0, Math.round(full.length * k));
    if (node.textContent !== txt) node.textContent = txt;
    node.classList.toggle("typing", lt >= from - 300 && lt < to + 500);
  }
  function between(lt, a, b) { return lt >= a && lt < b; }

  // Each scene is drawn purely from its local time, so any card can be shown at any moment.
  function scene1(lt) {
    typeInto(el.s1type, lt);
    el.s1type.classList.toggle("focus", between(lt, 800, 2600));
    el.add.classList.toggle("press", between(lt, 2900, 3150));
    el.conn.classList.toggle("show", lt >= 3200);
    el.conn.classList.toggle("on", lt >= 3950);
    return lt < 600 ? null : lt < 2600 ? el.s1type : lt < 3500 ? el.add : el.sw;
  }
  function scene2(lt) {
    typeInto(el.s2type, lt);
    el.s2type.classList.toggle("focus", between(lt, 700, 2500));
    el.mslot.classList.toggle("filled", lt >= 2200);
    el.copy.classList.toggle("press", between(lt, 3000, 3250));
    el.copy.classList.toggle("copied", lt >= 3100);
    return lt < 2500 ? el.s2type : el.copy;
  }
  function scene3(lt) {
    var sent = lt >= 1900;
    if (sent) { if (el.s3type.textContent) el.s3type.textContent = ""; el.s3type.classList.remove("typing"); }
    else typeInto(el.s3type, lt);
    el.send.classList.toggle("press", between(lt, 1700, 1900));
    el.me.classList.toggle("hide", !sent);
    el.t1.classList.toggle("hide", lt < 2400);
    el.t1.classList.toggle("done", lt >= 3400);
    el.t2.classList.toggle("hide", lt < 3700);
    el.t2.classList.toggle("done", lt >= 5800);
    el.t3.classList.toggle("hide", lt < 6100);
    el.t3.classList.toggle("done", lt >= 8000);
    el.ai.classList.toggle("hide", lt < 8400);
    return el.send;
  }
  var SCENES = [scene1, scene2, scene3];
  var CLICKS = [[2900, 3900], [3000], [1700]];

  var lastKey = null, lastClick = "";
  function aim(target) {
    if (!cursor) return;
    cursor.classList.toggle("show", !!target);
    if (!target) return;
    var sr = stage.getBoundingClientRect(), r = target.getBoundingClientRect();
    var x = r.left - sr.left + Math.min(r.width * 0.5, 60), y = r.top - sr.top + r.height * 0.55;
    var key = Math.round(x) + "," + Math.round(y);
    if (key === lastKey) return;
    lastKey = key;
    cursor.style.setProperty("--cx", x + "px");
    cursor.style.setProperty("--cy", y + "px");
  }
  function clickAt(id) {
    if (lastClick === id || !cursor) return;
    lastClick = id;
    cursor.classList.remove("click");
    void cursor.offsetWidth;
    cursor.classList.add("click");
  }

  function playing() { return !userPaused && loops < MAX_LOOPS; }
  function render() {
    var active = playing() ? (t >= START[2] ? 3 : t >= START[1] ? 2 : 1) : pinned;
    var target = null;
    each(cards, function (c, i) {
      var n = i + 1;
      var lt = playing() && n === active ? t - START[i] : END;
      c.classList.toggle("on", n === active);
      var hit = SCENES[i](lt);
      if (playing() && n === active) {
        target = hit;
        CLICKS[i].forEach(function (at) { if (between(lt, at, at + 100)) clickAt(n + ":" + at); });
      }
    });
    aim(target);
  }

  function setPlayLabel() {
    playBtn.setAttribute("data-paused", playing() ? "false" : "true");
    playBtn.querySelector("span").textContent = playing() ? "Pause" : "Play";
  }
  function running() { return playing() && onScreen && !document.hidden; }
  function frame(ts) {
    raf = 0;
    if (!running()) return;
    var dt = last ? Math.min(ts - last, 100) : 16;
    last = ts;
    t += dt;
    if (t >= LOOP) {
      loops++;
      t = 0; lastClick = "";
      if (loops >= MAX_LOOPS) { pinned = 0; render(); setPlayLabel(); return; }
    }
    render();
    raf = window.requestAnimationFrame(frame);
  }
  function kick() {
    if (running() && !raf) { last = 0; raf = window.requestAnimationFrame(frame); }
  }

  playBtn.hidden = false;
  each(capBtns, function (b) { b.disabled = false; });
  playBtn.addEventListener("click", function () {
    if (playing()) { userPaused = true; pinned = 0; }
    else { if (loops >= MAX_LOOPS) loops = 0; userPaused = false; t = 0; lastClick = ""; }
    setPlayLabel();
    render();
    kick();
  });
  each(capBtns, function (b) {
    b.addEventListener("click", function () {
      var n = +b.getAttribute("data-go");
      if (playing()) { t = START[n - 1]; lastClick = ""; }
      else pinned = n; // paused or reduced motion: highlight that card, already on its last frame
      render();
      kick();
    });
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      kick();
    }, { threshold: 0.2 }).observe(stage);
  }
  document.addEventListener("visibilitychange", kick);
  window.addEventListener("resize", function () { lastKey = null; });

  // Reduced motion: no autoplay; all three cards show their finished frame (the still, numbered version).
  setPlayLabel();
  render();
  kick();
})();
