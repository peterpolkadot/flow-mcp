// Credit safety for paid generations. Pure logic (no browser): flow.ts supplies the readers, tests supply fakes.
//
// Rule: nothing is submitted to Flow unless a quote read AFTER every input (model, duration, resolution, variants,
// references, prompt) is in place is a real number, is within the caller's cap, and fits the balance (when readable).
// Anything else aborts BEFORE the "Start generation" click, so nothing is spent.

/** Version marker exposed in flow_status so clients can tell this protection exists. */
export const PRICING_PROTOCOL = "final-v1";

export interface Billing {
  protocol: typeof PRICING_PROTOCOL;
  /** Settings the quote was read for (what Flow was actually set to, not just what was asked). */
  model?: string;
  duration?: number;
  resolution?: string;
  variants: number;
  reference_count: number;
  /** The authorised maximum for this job. */
  cap: number;
  /** Quote read when the model/duration/resolution/variants were applied (before references and prompt). Informational. */
  quote_initial?: number;
  /** Quote read immediately before the click, with every input attached. This is the one the cap is checked against. */
  quote_final?: number;
  /** true only when quote_final was read after all inputs and passed the gate; false/absent = never submitted. */
  final_verified: boolean;
  /** Balance read before submission / after the result. undefined = could not be read (never 0). */
  balance_before?: number;
  balance_after?: number;
  /**
   * How `charge_measured` was obtained. Flow exposes no per-job billing record, so the best evidence is the change in
   * the account balance across this job. flow-mcp runs one generation at a time, so no other flow-mcp job overlaps,
   * but spending done by hand in the Flow tab during the job cannot be seen: it is a MEASURED balance change, not a
   * verified per-job charge.
   */
  charge_basis: "balance_delta" | "unavailable";
  charge_measured?: number;
  /** Plain-language caveat for anything unverified. */
  evidence_note?: string;
  /** Why the gate refused, when it did. */
  blocked?: string;
}

export const newBilling = (p: { model?: string; duration?: number; resolution?: string; variants?: number; references?: number; cap: number }): Billing => ({
  protocol: PRICING_PROTOCOL, model: p.model, duration: p.duration, resolution: p.resolution,
  variants: p.variants ?? 1, reference_count: p.references ?? 0, cap: p.cap, final_verified: false, charge_basis: "unavailable",
});

/** "7 credits" -> 7. Anything that is not a clean non-negative integer is "unavailable" (undefined), never 0. */
export function parseQuote(text: string | undefined | null): number | undefined {
  const m = (text ?? "").match(/(\d[\d,]*)/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export class PriceGateError extends Error {}

export interface GateDeps {
  /** Re-reads the price Flow shows for the CURRENT composer state. Must throw or return undefined if it cannot. */
  readQuote: () => Promise<number | undefined>;
  /** Reads the account balance; undefined/throw = unknown. */
  readBalance: () => Promise<number | undefined>;
}

/**
 * Final gate, to be called immediately before the irreversible click. Mutates `billing` with the evidence and either
 * returns (safe to submit) or throws PriceGateError (do NOT submit).
 */
export async function verifyFinalPrice(billing: Billing, deps: GateDeps): Promise<void> {
  const block = (why: string): never => {
    billing.blocked = why;
    billing.final_verified = false;
    throw new PriceGateError(`${why} Nothing was generated and nothing was spent.`);
  };
  // Balance first, quote last: the quote must be the final thing read before the click.
  let bal: number | undefined;
  try { bal = await deps.readBalance(); } catch { bal = undefined; }
  if (bal !== undefined) billing.balance_before = bal;
  let q: number | undefined;
  try { q = await deps.readQuote(); } catch (e) { return block(`The final credit quote could not be read from Flow (${e instanceof Error ? e.message : e}).`); }
  if (q === undefined || !Number.isFinite(q) || q < 0) return block("Flow showed no readable credit quote for the final request.");
  billing.quote_final = q;
  if (q > billing.cap) {
    const hint = billing.quote_initial !== undefined && q > billing.quote_initial ? ` The price rose from ${billing.quote_initial} to ${q} after the inputs were attached.` : "";
    return block(`Flow's final quote is ${q} credits, above the authorised cap of ${billing.cap}.${hint}`);
  }
  if (bal !== undefined && bal < q) return block(`Insufficient credits: the final quote is ${q} but the balance is ${bal}.`);
  if (bal === undefined) billing.evidence_note = "The balance could not be read before submission, so a measured charge will not be available.";
  billing.final_verified = true;
}

/** Fills the after-the-fact fields. Never turns a missing reading into 0. */
export function recordCharge(billing: Billing, balanceAfter: number | undefined): void {
  billing.balance_after = balanceAfter;
  if (billing.balance_before !== undefined && balanceAfter !== undefined) {
    billing.charge_basis = "balance_delta";
    billing.charge_measured = billing.balance_before - balanceAfter;
    const extra = billing.quote_final !== undefined && billing.charge_measured !== billing.quote_final
      ? ` The measured change (${billing.charge_measured}) differs from the quote (${billing.quote_final}): spending by hand in Flow or a refund during the job could explain it.` : "";
    billing.evidence_note = `Measured from the account balance across this job (Flow has no per-job billing record).${extra}`;
  } else {
    billing.charge_basis = "unavailable";
    billing.charge_measured = undefined;
    billing.evidence_note = "The actual charge could not be measured (balance unreadable before or after). Check the Flow account; the quote was " + (billing.quote_final ?? "unknown") + ".";
  }
}
