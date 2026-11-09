/**
 * Innovation #2 — Marginal Utility / Cost-per-Signal ROI Scorer.
 *
 * The agent does not blindly buy anything under budget: each 402 quote is scored
 * as informationGain / priceUSDC and the execution plan is reordered highest-ROI
 * first. Utility ground truth comes from the agent's OWN value catalog; a
 * server's self-advertised utility from the 402 header is only trusted at a
 * 50% discount (a malicious seller cannot talk its way past the utility gate).
 */
import type { X402PaymentRequirements } from "./x402";
import { rawToNumber } from "./format";

export interface CatalogEntry {
  endpointUrl: string;
  label: string;
  description: string;
  /** Agent-assessed informational value of the payload, in USDC equivalent. */
  valueUSDC: string;
  /** Agent-assessed count of discrete, actionable data signals. */
  expectedSignals: number;
}

export const TRUST_DISCOUNT_FOR_ADVERTISED_UTILITY = 0.5;

export interface RoiScore {
  priceUSDC: number;
  /** Effective expected utility the agent assigns (catalog, or discounted claim). */
  expectedUtility: number;
  /** Information gain per USDC spent. */
  roi: number;
  /** Discrete signals per USDC spent. */
  signalsPerUSDC: number;
  source: "catalog" | "advertised-discounted";
}

export type RoiVerdict = "APPROVED" | "REFUSED_LOW_UTILITY";

export interface RoiEvaluation extends RoiScore {
  verdict: RoiVerdict;
  message: string;
}

export function scoreRoi(entry: CatalogEntry | null, priceRaw: bigint, challenge?: X402PaymentRequirements): RoiScore {
  const priceUSDC = rawToNumber(priceRaw);
  let expectedUtility: number;
  let expectedSignals: number;
  let source: RoiScore["source"];
  if (entry) {
    expectedUtility = Number(entry.valueUSDC);
    expectedSignals = entry.expectedSignals;
    source = "catalog";
  } else {
    const advertised = challenge?.extra.advertisedUtility;
    const claimValue = advertised ? Number(advertised.valueUSDC) : 0;
    expectedUtility = claimValue * TRUST_DISCOUNT_FOR_ADVERTISED_UTILITY;
    expectedSignals = advertised ? advertised.expectedSignals : 0;
    source = "advertised-discounted";
  }
  const denom = Math.max(priceUSDC, 1e-9);
  return {
    priceUSDC,
    expectedUtility,
    roi: expectedUtility / denom,
    signalsPerUSDC: expectedSignals / denom,
    source,
  };
}

/** Requirement 02.3: buy only when expectedUtility >= price. */
export function evaluateRoi(entry: CatalogEntry | null, priceRaw: bigint, challenge?: X402PaymentRequirements): RoiEvaluation {
  const score = scoreRoi(entry, priceRaw, challenge);
  const approved = score.expectedUtility + 1e-9 >= score.priceUSDC;
  return {
    ...score,
    verdict: approved ? "APPROVED" : "REFUSED_LOW_UTILITY",
    message: approved
      ? `Utility approved: expected ${score.expectedUtility.toFixed(2)} USDC-equivalent >= price ${score.priceUSDC.toFixed(2)} USDC (ROI ${score.roi.toFixed(2)}x, ${score.signalsPerUSDC.toFixed(0)} signals/USDC, source: ${score.source}).`
      : `Refused: expected utility ${score.expectedUtility.toFixed(2)} < price ${score.priceUSDC.toFixed(2)} USDC (ROI ${score.roi.toFixed(2)}x, source: ${score.source}).`,
  };
}

/** Rank endpoints by ROI (highest information-gain-per-USDC first). */
export function rankByRoi<T extends { entry: CatalogEntry | null; priceRaw: bigint; challenge?: X402PaymentRequirements }>(items: T[]): T[] {
  return [...items]
    .map((item) => ({ item, score: scoreRoi(item.entry, item.priceRaw, item.challenge) }))
    .sort((a, b) => b.score.roi - a.score.roi || (b.item.entry?.expectedSignals ?? 0) - (a.item.entry?.expectedSignals ?? 0))
    .map(({ item }) => item);
}
