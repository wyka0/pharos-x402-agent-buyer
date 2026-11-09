/**
 * Server-side x402 endpoint catalog: pricing, advertised utility, and
 * deterministic synthetic data producers for the four paywalled resources.
 *
 * Prices are raw USDC units (6 decimals):
 *   security-audit       0.10 USDC  (100_000)
 *   whale-telemetry      0.15 USDC  (150_000)
 *   mev-simulation       0.20 USDC  (200_000)
 *   institutional-alpha  0.50 USDC  (500_000)  <- deliberate over-cap TRAP
 */
import { keccak256, stringToHex, type Hex } from "viem";
import type { X402PaymentRequirements, AdvertisedUtility } from "../x402";

export type EndpointPath =
  | "/api/x402/security-audit"
  | "/api/x402/whale-telemetry"
  | "/api/x402/mev-simulation"
  | "/api/x402/institutional-alpha";

export interface EndpointData {
  [key: string]: unknown;
}

export interface EndpointSpec {
  path: EndpointPath;
  priceRaw: bigint;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  advertisedUtility: AdvertisedUtility;
  produce(input: { resource: string; nonce: Hex; query: URLSearchParams }): EndpointData;
  whatItBought: string;
}

// --- deterministic PRNG from the challenge nonce -------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prngFromNonce(nonce: Hex): () => number {
  const digest = keccak256(stringToHex(`data:${nonce}`));
  const seed = parseInt(digest.slice(2, 10), 16);
  return mulberry32(seed);
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function randFloat(rng: () => number, min: number, max: number, digits = 2): number {
  return Number((min + rng() * (max - min)).toFixed(digits));
}

function fakeAddress(rng: () => number): string {
  const hexChars = "0123456789abcdef";
  let out = "0x";
  for (let i = 0; i < 40; i++) out += hexChars[Math.floor(rng() * 16)];
  return out;
}

// --- producers ------------------------------------------------------------------

const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
const FINDING_TITLES = [
  "Unbounded loop allows gas griefing",
  "Unchecked return value on external call",
  "Floating pragma in production artifact",
  "Missing zero-address guard on initializer",
  "State variable shadows inherited storage",
  "Event missing indexed parameter",
  "Division-before-multiplication rounding loss",
  "Stale oracle timestamp accepted",
  "Reentrancy guard absent on withdraw path",
  "Unsafe ERC-20 return-value assumption",
] as const;

function produceSecurityAudit(nonce: Hex): EndpointData {
  const rng = prngFromNonce(nonce);
  const findings = Array.from({ length: 5 }, (_, i) => ({
    id: `F-${i + 1}`,
    severity: pick(rng, SEVERITIES),
    swcId: `SWC-${randInt(rng, 100, 135)}`,
    title: pick(rng, FINDING_TITLES),
    confidence: randFloat(rng, 0.55, 0.99, 2),
  }));
  return {
    resource: "security-audit",
    contractUnderReview: fakeAddress(rng),
    bytecodeHash: keccak256(stringToHex(`bytecode:${nonce}`)),
    riskScore: randInt(rng, 18, 87),
    verdict: rng() > 0.5 ? "CONDITIONAL_PASS" : "NEEDS_REMEDIATION",
    findings,
    gasHotspots: Array.from({ length: 3 }, () => ({ fn: pick(rng, ["swap", "mint", "redeem", "claim", "govern"]) , deltaPct: randInt(rng, 3, 28) })),
  };
}

function produceWhaleTelemetry(nonce: Hex): EndpointData {
  const rng = prngFromNonce(nonce);
  const topHolders = Array.from({ length: 10 }, (_, i) => ({
    rank: i + 1,
    address: fakeAddress(rng),
    sharePct: randFloat(rng, 0.4, 14.5, 2),
    delta24hPct: randFloat(rng, -6.2, 9.8, 2),
    tag: pick(rng, ["whale", "smart-money", "exchange", "lp-treasury", "sniper"]),
  }));
  const inflow = randFloat(rng, 12_000, 480_000, 0);
  const outflow = randFloat(rng, 9_000, 402_000, 0);
  return {
    resource: "whale-telemetry",
    token: "USDC (Pharos Atlantic)",
    topHolderConcentrationPct: Number(topHolders.reduce((s, h) => s + h.sharePct, 0).toFixed(2)),
    topHolders,
    liquidityFlow: {
      inflowUSDC: inflow,
      outflowUSDC: outflow,
      netUSDC: Number((inflow - outflow).toFixed(0)),
    },
    whaleAlerts: Array.from({ length: randInt(rng, 1, 4) }, () => ({
      address: fakeAddress(rng),
      action: pick(rng, ["ACCUMULATE", "DISTRIBUTE", "ROTATE_TO_LP"]),
      usdcAmount: randInt(rng, 5_000, 250_000),
    })),
  };
}

function produceMevSimulation(nonce: Hex): EndpointData {
  const rng = prngFromNonce(nonce);
  return {
    resource: "mev-simulation",
    route: [fakeAddress(rng), fakeAddress(rng), fakeAddress(rng)],
    slippageBps: randInt(rng, 4, 220),
    sandwichRiskScore: randInt(rng, 5, 95),
    frontrunProbabilityPct: randFloat(rng, 0.2, 41.0, 1),
    recommendedMaxTradeUSDC: randInt(rng, 250, 90_000),
    pools: Array.from({ length: 3 }, () => ({
      pair: "USDC/PHRS",
      tvlUSDC: randInt(rng, 40_000, 1_400_000),
      feeTierBps: pick(rng, [1, 5, 30]),
    })),
  };
}

function produceInstitutionalAlpha(nonce: Hex): EndpointData {
  const rng = prngFromNonce(nonce);
  return {
    resource: "institutional-alpha",
    confidential: true,
    feed: "Institutional Alpha Flow (desk-grade)",
    signals: Array.from({ length: 4 }, () => ({
      symbol: pick(rng, ["PHRS", "USDC", "WPHRS", "WBTC"]),
      bias: pick(rng, ["LONG", "SHORT", "NEUTRAL"]),
      conviction: randFloat(rng, 0.51, 0.97, 2),
      horizonHours: randInt(rng, 4, 120),
    })),
    note: "Priced intentionally above the demo per-call cap to exercise hard refusal.",
  };
}

// --- catalog ----------------------------------------------------------------------

export const ENDPOINT_SPECS: Record<EndpointPath, EndpointSpec> = {
  "/api/x402/security-audit": {
    path: "/api/x402/security-audit",
    priceRaw: 100_000n,
    description: "Contract bytecode vulnerability telemetry: risk score, SWC-classified findings, gas hotspots.",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
    advertisedUtility: { valueUSDC: "0.20", expectedSignals: 12 },
    produce: ({ nonce }) => produceSecurityAudit(nonce),
    whatItBought: "Security audit telemetry (risk score + 5 SWC findings + gas hotspots)",
  },
  "/api/x402/whale-telemetry": {
    path: "/api/x402/whale-telemetry",
    priceRaw: 150_000n,
    description: "Pharos Atlantic top-holder concentration and liquidity flow analytics.",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
    advertisedUtility: { valueUSDC: "0.30", expectedSignals: 20 },
    produce: ({ nonce }) => produceWhaleTelemetry(nonce),
    whatItBought: "Whale telemetry (top-10 holder concentration + liquidity flow + alerts)",
  },
  "/api/x402/mev-simulation": {
    path: "/api/x402/mev-simulation",
    priceRaw: 200_000n,
    description: "Slippage and sandwich-risk simulation for a reference trade route.",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
    advertisedUtility: { valueUSDC: "0.35", expectedSignals: 15 },
    produce: ({ nonce }) => produceMevSimulation(nonce),
    whatItBought: "MEV simulation (slippage bps + sandwich risk + recommended max trade)",
  },
  "/api/x402/institutional-alpha": {
    path: "/api/x402/institutional-alpha",
    priceRaw: 500_000n,
    description: "Desk-grade institutional alpha feed. Deliberately overpriced to exercise the per-call cap refusal.",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
    advertisedUtility: { valueUSDC: "0.05", expectedSignals: 8 },
    produce: ({ nonce }) => produceInstitutionalAlpha(nonce),
    whatItBought: "Institutional alpha feed (over-cap trap — expected to be refused)",
  },
};

export function getSpecByPath(path: string): EndpointSpec | null {
  const spec = (ENDPOINT_SPECS as Record<string, EndpointSpec | undefined>)[path];
  return spec ?? null;
}

export function expectedPriceForPath(path: string): bigint | null {
  return getSpecByPath(path)?.priceRaw ?? null;
}

export function endpointCatalogForUi(): Array<{
  path: string;
  priceRaw: string;
  priceUSDC: string;
  description: string;
  advertisedUtility: AdvertisedUtility;
  trap?: boolean;
}> {
  const fmt = (raw: bigint) => `${Number(raw) / 1e6}`;
  return (Object.keys(ENDPOINT_SPECS) as EndpointPath[]).map((p) => ({
    path: p,
    priceRaw: ENDPOINT_SPECS[p].priceRaw.toString(),
    priceUSDC: fmt(ENDPOINT_SPECS[p].priceRaw),
    description: ENDPOINT_SPECS[p].description,
    advertisedUtility: ENDPOINT_SPECS[p].advertisedUtility,
    trap: p === "/api/x402/institutional-alpha" || undefined,
  }));
}

/** Agent-side value catalog (ground truth for the ROI gate). */
export const AGENT_VALUE_CATALOG: Record<string, { label: string; valueUSDC: string; expectedSignals: number; description: string }> = {
  "/api/x402/security-audit": {
    label: "Security Audit",
    valueUSDC: "0.20",
    expectedSignals: 12,
    description: ENDPOINT_SPECS["/api/x402/security-audit"].description,
  },
  "/api/x402/whale-telemetry": {
    label: "Whale Telemetry",
    valueUSDC: "0.30",
    expectedSignals: 20,
    description: ENDPOINT_SPECS["/api/x402/whale-telemetry"].description,
  },
  "/api/x402/mev-simulation": {
    label: "MEV Simulation",
    valueUSDC: "0.35",
    expectedSignals: 15,
    description: ENDPOINT_SPECS["/api/x402/mev-simulation"].description,
  },
  "/api/x402/institutional-alpha": {
    label: "Institutional Alpha (trap)",
    valueUSDC: "0.05",
    expectedSignals: 8,
    description: ENDPOINT_SPECS["/api/x402/institutional-alpha"].description,
  },
};
