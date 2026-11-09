import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { evaluateRoi, scoreRoi, rankByRoi, type CatalogEntry } from "@/lib/roi";
import { AGENT_VALUE_CATALOG } from "@/lib/server/catalog";
import { parseUsdcToRaw } from "@/lib/format";
import type { X402PaymentRequirements } from "@/lib/x402";

const usdc = (s: string) => parseUsdcToRaw(s);

const catalogEntry: CatalogEntry = {
  endpointUrl: "http://test.local/api/x402/security-audit",
  label: "Security Audit",
  description: "audit telemetry",
  valueUSDC: "0.20",
  expectedSignals: 12,
};

function fakeChallenge(claimValueUSDC: string, claimSignals: number): X402PaymentRequirements {
  return {
    x402Version: 2,
    scheme: "exact",
    network: "eip155:688689",
    asset: "0x0",
    payTo: "0x0",
    maxAmountRequired: "100000",
    resource: "http://test.local/api/x402/unknown",
    description: "unknown",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
    extra: {
      name: "USDC",
      version: "2",
      chainId: 688689,
      nonce: ("0x" + "0".repeat(64)) as Hex,
      idempotencyKey: ("0x" + "0".repeat(64)) as Hex,
      quoteCommitment: ("0x" + "0".repeat(64)) as Hex,
      advertisedUtility: { valueUSDC: claimValueUSDC, expectedSignals: claimSignals },
    },
  };
}

describe("Innovation #2: marginal utility / cost-per-signal ROI scorer", () => {
  it("approves when expected utility >= price (0.20 >= 0.10)", () => {
    const e = evaluateRoi(catalogEntry, usdc("0.10"));
    expect(e.verdict).toBe("APPROVED");
    expect(e.roi).toBeCloseTo(2.0);
    expect(e.signalsPerUSDC).toBeCloseTo(120);
  });

  it("approves at exact utility/price parity (boundary)", () => {
    const e = evaluateRoi({ ...catalogEntry, valueUSDC: "0.15" }, usdc("0.15"));
    expect(e.verdict).toBe("APPROVED");
  });

  it("refuses when expected utility < price", () => {
    const e = evaluateRoi({ ...catalogEntry, valueUSDC: "0.05" }, usdc("0.10"));
    expect(e.verdict).toBe("REFUSED_LOW_UTILITY");
    expect(e.message).toContain("Refused");
  });

  it("refuses the institutional-alpha trap (0.05 value vs 0.50 price)", () => {
    const entry: CatalogEntry = {
      endpointUrl: "http://test.local/api/x402/institutional-alpha",
      label: "Institutional Alpha (trap)",
      description: "overpriced",
      valueUSDC: "0.05",
      expectedSignals: 8,
    };
    const e = evaluateRoi(entry, usdc("0.50"));
    expect(e.verdict).toBe("REFUSED_LOW_UTILITY");
    expect(e.roi).toBeCloseTo(0.1);
  });

  it("discounts advertised utility from unknown endpoints by 50%", () => {
    const score = scoreRoi(null, usdc("0.10"), fakeChallenge("0.30", 20));
    expect(score.source).toBe("advertised-discounted");
    expect(score.expectedUtility).toBeCloseTo(0.15);
    // 0.15 >= 0.10 -> still approved but at the discounted rate
    const e = evaluateRoi(null, usdc("0.10"), fakeChallenge("0.30", 20));
    expect(e.verdict).toBe("APPROVED");
  });

  it("refuses unknown endpoints that over-claim even before discounting would pass", () => {
    const e = evaluateRoi(null, usdc("0.20"), fakeChallenge("0.30", 20));
    expect(e.verdict).toBe("REFUSED_LOW_UTILITY"); // 0.15 discounted < 0.20
  });

  it("refuses unknown endpoints with no advertised utility at all", () => {
    const e = evaluateRoi(null, usdc("0.01"), undefined);
    expect(e.verdict).toBe("REFUSED_LOW_UTILITY");
    expect(e.expectedUtility).toBe(0);
  });

  it("catalog values always beat advertised claims (no source confusion)", () => {
    const catalogScore = scoreRoi(catalogEntry, usdc("0.10"), fakeChallenge("999", 999));
    expect(catalogScore.source).toBe("catalog");
    expect(catalogScore.expectedUtility).toBeCloseTo(0.20);
  });

  it("ranks endpoints by information-gain per USDC, highest first", () => {
    const audit: CatalogEntry = { ...catalogEntry, endpointUrl: "audit", label: "audit", valueUSDC: "0.20", expectedSignals: 12 };
    const whale: CatalogEntry = { ...catalogEntry, endpointUrl: "whale", label: "whale", valueUSDC: "0.30", expectedSignals: 20 };
    const mev: CatalogEntry = { ...catalogEntry, endpointUrl: "mev", label: "mev", valueUSDC: "0.35", expectedSignals: 15 };
    const ranked = rankByRoi([
      { entry: mev, priceRaw: usdc("0.20") }, // ROI 1.75
      { entry: whale, priceRaw: usdc("0.15") }, // ROI 2.0
      { entry: audit, priceRaw: usdc("0.10") }, // ROI 2.0
    ]);
    // whale (2.0, more signals) before audit (2.0) before mev (1.75)
    expect(ranked.map((r) => r.entry!.endpointUrl)).toEqual(["whale", "audit", "mev"]);
  });

  it("tie-breaks equal ROI by expected signal count", () => {
    const a: CatalogEntry = { ...catalogEntry, endpointUrl: "a", valueUSDC: "0.20", expectedSignals: 10 };
    const b: CatalogEntry = { ...catalogEntry, endpointUrl: "b", valueUSDC: "0.20", expectedSignals: 20 };
    const ranked = rankByRoi([
      { entry: a, priceRaw: usdc("0.10") },
      { entry: b, priceRaw: usdc("0.10") },
    ]);
    expect(ranked[0].entry!.endpointUrl).toBe("b");
  });

  it("scores every endpoint in the shipped value catalog consistently", () => {
    const prices: Record<string, bigint> = {
      "/api/x402/security-audit": usdc("0.10"),
      "/api/x402/whale-telemetry": usdc("0.15"),
      "/api/x402/mev-simulation": usdc("0.20"),
      "/api/x402/institutional-alpha": usdc("0.50"),
    };
    for (const [path, entry] of Object.entries(AGENT_VALUE_CATALOG)) {
      const e = evaluateRoi({ ...entry, endpointUrl: path }, prices[path]);
      if (path === "/api/x402/institutional-alpha") {
        expect(e.verdict).toBe("REFUSED_LOW_UTILITY");
      } else {
        expect(e.verdict).toBe("APPROVED");
      }
    }
  });

  it("produces higher ROI for cheaper equal-utility endpoints", () => {
    const cheap = scoreRoi({ ...catalogEntry, valueUSDC: "0.30" }, usdc("0.10"));
    const pricey = scoreRoi({ ...catalogEntry, valueUSDC: "0.30" }, usdc("0.20"));
    expect(cheap.roi).toBeGreaterThan(pricey.roi);
    expect(cheap.roi).toBeCloseTo(pricey.roi * 2);
  });
});
