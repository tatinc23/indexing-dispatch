import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, sanitizeText, stripUrl, type Snapshot } from "../src/classify.js";

const base: Snapshot = {
  url: "https://search.brave.com/submit-url",
  buttons: [{ text: "Submit", disabled: false }],
  headings: [],
  alerts: [],
  inputInvalid: false,
  confirmation: null,
  challenge: { frames: [], text: null },
  bodyText: "",
};
const snap = (over: Partial<Snapshot>): Snapshot => ({ ...base, ...over });

describe("classify", () => {
  it("accepts message + Success heading", () => {
    const o = classify(snap({ confirmation: { messageText: "Thank you for your submission.", regionText: "Success Thank you for your submission.", hasSuccessHeading: true } }));
    assert.equal(o.kind, "accepted");
  });

  it("accepts message + disabled 'Submitted' button even without a heading match", () => {
    const o = classify(
      snap({
        buttons: [{ text: "Submitted", disabled: true }],
        confirmation: { messageText: "Thank you for your submission.", regionText: "Thank you for your submission.", hasSuccessHeading: false },
      }),
    );
    assert.equal(o.kind, "accepted");
  });

  it("does NOT accept the message alone", () => {
    const o = classify(snap({ confirmation: { messageText: "Thank you for your submission.", regionText: "Thank you for your submission.", hasSuccessHeading: false } }));
    assert.equal(o.kind, "pending");
  });

  it("does NOT accept a 'Success' heading or 'Submitted' button without the message", () => {
    assert.equal(classify(snap({ headings: ["Success"] })).kind, "pending");
    assert.equal(classify(snap({ buttons: [{ text: "Submitted", disabled: true }] })).kind, "pending");
  });

  it("treats a 'Submit' button as not submitted (never matches 'Submitted')", () => {
    assert.equal(classify(snap({ buttons: [{ text: "Submit", disabled: true }] })).kind, "pending");
  });

  it("rejects on an explicit error alert", () => {
    const o = classify(snap({ alerts: [{ text: "Something went wrong. Please try again later.", role: "alert", explicitError: false }] }));
    assert.equal(o.kind, "rejected");
  });

  it("rejects on an element explicitly styled as an error even with unfamiliar wording", () => {
    const o = classify(snap({ alerts: [{ text: "Nope.", role: "", explicitError: true }] }));
    assert.equal(o.kind, "rejected");
  });

  it("ignores the privacy-metrics notice and non-error alerts", () => {
    assert.equal(classify(snap({ alerts: [{ text: "Brave Search uses private usage metrics to estimate overall activity", role: "alert", explicitError: true }] })).kind, "pending");
    assert.equal(classify(snap({ alerts: [{ text: "Saved", role: "alert", explicitError: false }] })).kind, "pending");
  });

  it("rejects when the input is flagged invalid", () => {
    assert.equal(classify(snap({ inputInvalid: true })).kind, "rejected");
  });

  it("reports verification only for human-action challenges", () => {
    assert.equal(classify(snap({ challenge: { frames: ["challenges.cloudflare.com"], text: null } })).kind, "verification");
    assert.equal(classify(snap({ challenge: { frames: [], text: "I'm not a robot" } })).kind, "verification");
  });

  it("treats passive 'checking' text as pending, not verification", () => {
    const o = classify(snap({ bodyText: "Checking your browser… Verifying", buttons: [{ text: "Checking…", disabled: true }] }));
    assert.equal(o.kind, "pending");
  });

  it("success wins over a stale alert", () => {
    const o = classify(
      snap({
        alerts: [{ text: "Failed earlier", role: "alert", explicitError: true }],
        buttons: [{ text: "Submitted", disabled: true }],
        confirmation: { messageText: "Thank you for your submission.", regionText: "Success Thank you for your submission.", hasSuccessHeading: true },
      }),
    );
    assert.equal(o.kind, "accepted");
  });
});

describe("sanitizers", () => {
  it("redacts long token-like strings and truncates", () => {
    const token = "abcDEF0123456789abcDEF0123456789abcDEF";
    const out = sanitizeText(`session ${token} done`);
    assert.equal(out, "session [redacted] done");
    assert.ok(sanitizeText("x ".repeat(2000), 100).length <= 101);
  });

  it("strips query and fragment from URLs", () => {
    assert.equal(stripUrl("https://search.brave.com/submit-url?token=abc#x"), "https://search.brave.com/submit-url");
    assert.equal(stripUrl("garbage"), "");
  });
});
