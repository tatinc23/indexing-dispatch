// Prompt helper: fills the page address into the prompts and copies them.
// Without JS the prompts are plain selectable text and these controls stay hidden.
// All copied text comes from the DOM, so the build's URL substitutions are what gets copied.
(function () {
  "use strict";
  var slots = document.querySelectorAll(".slot");
  var form = document.getElementById("go");
  var input = document.getElementById("page-url");
  var hint = document.getElementById("url-hint");
  var next = document.getElementById("next");
  var peek = document.getElementById("peek");
  var cap = document.getElementById("prompt-cap");
  var prompts = document.querySelectorAll(".prompt[data-variant]");
  var toast = document.getElementById("toast");
  var toastText = document.getElementById("toast-text");
  var PLACEHOLDER = slots.length ? slots[0].textContent : "";
  var HINT = hint ? hint.textContent : "";
  var NEXT = next ? next.innerHTML : "";
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
    Array.prototype.forEach.call(slots, function (s) {
      s.textContent = text;
      s.classList.toggle("filled", filled);
    });
  }

  function currentPrompt() {
    var picked = form ? form.querySelector('input[name="what"]:checked') : null;
    var want = picked ? picked.value : "both";
    var found = null;
    Array.prototype.forEach.call(prompts, function (p) { if (p.getAttribute("data-variant") === want) found = p; });
    return found || prompts[0];
  }

  function showVariant() {
    var cur = currentPrompt();
    Array.prototype.forEach.call(prompts, function (p) { p.hidden = p !== cur; });
    if (cap && cur) cap.textContent = cur.getAttribute("data-cap");
    resetNext();
  }

  function resetNext() {
    if (!next) return;
    next.innerHTML = NEXT;
    next.classList.remove("ok");
  }

  if (form && input && slots.length && prompts.length) {
    form.hidden = false;
    if (peek) peek.removeAttribute("open");
    showVariant();
    input.addEventListener("input", function () {
      var v = normalise(input.value);
      resetNext();
      if (v) {
        setSlots(v, true);
        input.removeAttribute("aria-invalid");
        hint.textContent = HINT;
        hint.classList.remove("bad");
      } else {
        setSlots(PLACEHOLDER, false);
        if (v === null) {
          input.setAttribute("aria-invalid", "true");
          hint.textContent = "That doesn't look like a web address yet, e.g. yourbusiness.com";
          hint.classList.add("bad");
        } else {
          input.removeAttribute("aria-invalid");
          hint.textContent = HINT;
          hint.classList.remove("bad");
        }
      }
    });
    form.querySelectorAll('input[name="what"]').forEach(function (r) { r.addEventListener("change", showVariant); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = normalise(input.value);
      if (!v) {
        input.setAttribute("aria-invalid", "true");
        hint.textContent = v === null ? "That doesn't look like a web address yet, e.g. yourbusiness.com" : "Add your website link first, then copy.";
        hint.classList.add("bad");
        input.focus();
        return;
      }
      setSlots(v, true);
      var target = currentPrompt();
      copyEl(target).then(function (ok) {
        if (ok) {
          say("Prompt copied");
          next.innerHTML = "Copied. Now paste it into your AI, with brave-submitter switched on. Not set up yet? <a href=\"#connect\">Plug it in once</a>.";
          next.classList.add("ok");
        } else {
          if (peek) peek.setAttribute("open", "");
          selectNode(target);
          say("Selected. Press Ctrl+C or Cmd+C to copy.");
        }
      });
    });
  }

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

  // Big Copy buttons on each prompt.
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy-prompt]"), function (btn) {
    btn.hidden = false;
    btn.addEventListener("click", function () {
      var target = prompts.length ? currentPrompt() : null;
      if (!target) return;
      var filled = !!target.querySelector(".slot.filled");
      copyEl(target).then(function (ok) {
        if (ok) say(filled ? "Prompt copied" : "Prompt copied. Swap in your page address before sending.");
        else { selectNode(target); say("Selected. Press Ctrl+C or Cmd+C to copy."); }
      });
    });
  });

  // Small copy buttons for the server address and config snippets.
  Array.prototype.forEach.call(document.querySelectorAll(".copy-snip[data-copy]"), function (b) {
    var target = document.getElementById(b.getAttribute("data-copy"));
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
})();
