// Unit tests for the credit gate (no browser, no credits). Run: npm test  (builds first)
import test from "node:test";
import assert from "node:assert/strict";
import { newBilling, parseQuote, recordCharge, verifyFinalPrice, PriceGateError, PRICING_PROTOCOL } from "../dist/pricing.js";

// A tiny model of Flow's composer: the price depends on settings AND on how many references are attached.
function composer({ base = 7, perRef = 0, balance = 1000, quoteText } = {}) {
  const st = { refs: 0, readsQuote: 0, started: 0, balance };
  return { st,
    attach: (n = 1) => { st.refs += n; },
    deps: { readQuote: async () => { st.readsQuote++; return quoteText !== undefined ? parseQuote(quoteText) : base + perRef * st.refs; }, readBalance: async () => st.balance },
    start: () => { st.started++; } };
}
const bill = (cap, extra = {}) => { const b = newBilling({ model: "Omni 1.1 Flash", duration: 4, resolution: "720p", cap, ...extra }); b.quote_initial = 7; return b; };
const gate = async (b, c) => { await verifyFinalPrice(b, c.deps); c.start(); };   // the production order: gate THEN start

test("parseQuote: only clean numbers; never 0 for missing", () => {
  assert.equal(parseQuote("7 credits"), 7); assert.equal(parseQuote("1,030 credits"), 1030); assert.equal(parseQuote("0 credits"), 0);
  for (const t of ["", "free", undefined, null, "credits"]) assert.equal(parseQuote(t), undefined, String(t));
});

test("quote unchanged after references: submits, final quote recorded and verified", async () => {
  const c = composer({ base: 7 }); c.attach(1); const b = bill(10, { references: 1 });
  await gate(b, c);
  assert.equal(c.st.started, 1); assert.equal(b.quote_final, 7); assert.equal(b.final_verified, true); assert.equal(b.balance_before, 1000);
  assert.equal(c.st.readsQuote, 1);
});

test("quote increases but stays within cap: submits using the NEW quote", async () => {
  const c = composer({ base: 7, perRef: 1 }); c.attach(3); const b = bill(10, { references: 3 });
  await gate(b, c);
  assert.equal(b.quote_initial, 7); assert.equal(b.quote_final, 10); assert.equal(c.st.started, 1); assert.equal(b.reference_count, 3);
});

test("quote increase after reference attachment pushes it over the cap: blocked, nothing started", async () => {
  const c = composer({ base: 7, perRef: 2 }); c.attach(3); const b = bill(10, { references: 3 });   // 13 > 10, early quote (7) was fine
  await assert.rejects(gate(b, c), (e) => e instanceof PriceGateError && /above the authorised cap of 10/.test(e.message) && /rose from 7 to 13/.test(e.message) && /nothing was spent/.test(e.message));
  assert.equal(c.st.started, 0); assert.equal(b.final_verified, false); assert.equal(b.quote_final, 13); assert.ok(b.blocked);
});

test("quote exactly equal to the cap is allowed; one above is not", async () => {
  let c = composer({ base: 10 }); await gate(bill(10), c); assert.equal(c.st.started, 1);
  c = composer({ base: 11 }); await assert.rejects(gate(bill(10), c), PriceGateError); assert.equal(c.st.started, 0);
});

test("final quote unavailable (unparseable, missing, throws): blocked, never treated as 0", async () => {
  for (const text of ["", "free", "credits"]) {
    const c = composer({ quoteText: text }); const b = bill(10);
    await assert.rejects(gate(b, c), (e) => e instanceof PriceGateError && /no readable credit quote/.test(e.message)); assert.equal(c.st.started, 0); assert.equal(b.quote_final, undefined);
  }
  const c = composer(); c.deps.readQuote = async () => { throw new Error("popover did not open"); }; const b = bill(10);
  await assert.rejects(gate(b, c), /could not be read from Flow \(popover did not open\)/); assert.equal(c.st.started, 0); assert.equal(b.final_verified, false);
});

test("insufficient balance blocks even when within cap", async () => {
  const c = composer({ base: 7, balance: 5 }); const b = bill(10);
  await assert.rejects(gate(b, c), /Insufficient credits: the final quote is 7 but the balance is 5/); assert.equal(c.st.started, 0);
});

test("balance unreadable: still gated by quote and cap, but no measured charge is promised", async () => {
  const c = composer({ base: 7 }); c.deps.readBalance = async () => { throw new Error("account panel"); }; const b = bill(10);
  await gate(b, c); assert.equal(c.st.started, 1); assert.equal(b.balance_before, undefined); assert.match(b.evidence_note, /balance could not be read/);
  recordCharge(b, 993);
  assert.equal(b.charge_basis, "unavailable"); assert.equal(b.charge_measured, undefined); assert.match(b.evidence_note, /could not be measured/);
});

test("measured charge = balance delta, labelled as measured; mismatch with quote is flagged; missing reading is not zero", async () => {
  const c = composer({ base: 7 }); const b = bill(10); await gate(b, c);
  recordCharge(b, 993);
  assert.equal(b.charge_basis, "balance_delta"); assert.equal(b.charge_measured, 7); assert.equal(b.balance_after, 993); assert.doesNotMatch(b.evidence_note, /differs/);
  const b2 = bill(10); await gate(b2, composer({ base: 7 })); recordCharge(b2, 985);
  assert.equal(b2.charge_measured, 15); assert.match(b2.evidence_note, /differs from the quote/);
  const b3 = bill(10); await gate(b3, composer({ base: 7 })); recordCharge(b3, undefined);
  assert.equal(b3.charge_basis, "unavailable"); assert.equal(b3.charge_measured, undefined);
});

test("zero-cap (free still) with a nonzero quote is blocked", async () => {
  const c = composer({ base: 3 }); await assert.rejects(gate(bill(0), c), PriceGateError); assert.equal(c.st.started, 0);
  const free = composer({ base: 0 }); await gate(bill(0), free); assert.equal(free.st.started, 1);
});

test("the gate always re-reads: an earlier quote is never reused", async () => {
  const c = composer({ base: 7 }); const b = bill(10); b.quote_initial = 1;   // a stale, lower early quote must not matter
  await gate(b, c); assert.equal(c.st.readsQuote, 1); assert.equal(b.quote_final, 7);
});

test("protocol marker", () => assert.equal(PRICING_PROTOCOL, "final-v1"));
