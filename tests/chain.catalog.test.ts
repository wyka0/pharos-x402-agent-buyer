import { describe, it, expect } from "vitest";
import { CHAIN_ID, NETWORK_ID, NETWORK_NAME, DEFAULT_RPC_URL, DEFAULT_USDC_ADDRESS, DEFAULT_EXPLORER_URL, pharosAtlantic, explorerTxUrl, explorerAddressUrl, USDC_DECIMALS, X402_VERSION, X402_SCHEME } from "@/lib/chain";
import { AGENT_VALUE_CATALOG, ENDPOINT_SPECS } from "@/lib/server/catalog";

describe("Pharos Atlantic chain configuration", () => {
  it("pins the official Atlantic testnet parameters", () => {
    expect(CHAIN_ID).toBe(688689);
    expect(NETWORK_ID).toBe("eip155:688689");
    expect(NETWORK_NAME).toBe("Pharos Atlantic Testnet");
    expect(DEFAULT_RPC_URL).toBe("https://atlantic.dplabs-internal.com");
    expect(DEFAULT_EXPLORER_URL).toBe("https://atlantic.pharosscan.xyz");
    expect(DEFAULT_USDC_ADDRESS).toBe("0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B");
    expect(USDC_DECIMALS).toBe(6);
    expect(X402_VERSION).toBe(2);
    expect(X402_SCHEME).toBe("exact");
  });

  it("defines a valid viem chain", () => {
    const chain = pharosAtlantic();
    expect(chain.id).toBe(688689);
    expect(chain.nativeCurrency).toEqual({ name: "PHRS", symbol: "PHRS", decimals: 18 });
    expect(chain.rpcUrls.default.http[0]).toBe(DEFAULT_RPC_URL);
    expect(chain.blockExplorers?.default.url).toBe(DEFAULT_EXPLORER_URL);
    expect(chain.testnet).toBe(true);
  });

  it("accepts a custom RPC URL", () => {
    const chain = pharosAtlantic("https://custom-rpc.example.com");
    expect(chain.rpcUrls.default.http[0]).toBe("https://custom-rpc.example.com");
  });

  it("builds explorer links only for valid hashes/addresses", () => {
    const tx = "0x" + "ab".repeat(32);
    expect(explorerTxUrl(tx)).toBe(`${DEFAULT_EXPLORER_URL}/tx/${tx}`);
    const addr = "0x" + "cd".repeat(20);
    expect(explorerAddressUrl(addr)).toBe(`${DEFAULT_EXPLORER_URL}/address/${addr}`);
    expect(() => explorerTxUrl("0x1234")).toThrow();
    expect(() => explorerAddressUrl("0x1234")).toThrow();
  });
});

describe("Endpoint catalog (Requirement 01)", () => {
  it("ships exactly four paywalled endpoints with spec-exact prices", () => {
    expect(Object.keys(ENDPOINT_SPECS)).toHaveLength(4);
    expect(ENDPOINT_SPECS["/api/x402/security-audit"].priceRaw).toBe(100_000n);
    expect(ENDPOINT_SPECS["/api/x402/whale-telemetry"].priceRaw).toBe(150_000n);
    expect(ENDPOINT_SPECS["/api/x402/mev-simulation"].priceRaw).toBe(200_000n);
    expect(ENDPOINT_SPECS["/api/x402/institutional-alpha"].priceRaw).toBe(500_000n);
  });

  it("gives every endpoint a description, utility claim, and data producer", () => {
    for (const spec of Object.values(ENDPOINT_SPECS)) {
      expect(spec.description.length).toBeGreaterThan(10);
      expect(Number(spec.advertisedUtility.valueUSDC)).toBeGreaterThan(0);
      expect(spec.advertisedUtility.expectedSignals).toBeGreaterThan(0);
      expect(typeof spec.produce).toBe("function");
      expect(spec.mimeType).toBe("application/json");
    }
  });

  it("produces deterministic, distinct data per nonce", () => {
    const spec = ENDPOINT_SPECS["/api/x402/security-audit"];
    const nonceA = ("0x" + "01".repeat(32)) as `0x${string}`;
    const nonceB = ("0x" + "02".repeat(32)) as `0x${string}`;
    const a1 = spec.produce({ resource: "r", nonce: nonceA, query: new URLSearchParams() });
    const a2 = spec.produce({ resource: "r", nonce: nonceA, query: new URLSearchParams() });
    const b = spec.produce({ resource: "r", nonce: nonceB, query: new URLSearchParams() });
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });

  it("covers all four endpoint paths in the agent value catalog", () => {
    expect(Object.keys(AGENT_VALUE_CATALOG)).toHaveLength(4);
    expect(AGENT_VALUE_CATALOG["/api/x402/institutional-alpha"].valueUSDC).toBe("0.05");
    expect(AGENT_VALUE_CATALOG["/api/x402/whale-telemetry"].valueUSDC).toBe("0.30");
  });
});
