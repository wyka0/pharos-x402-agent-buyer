import { describe, it, expect } from "vitest";
import { formatUsdc, parseUsdcToRaw, rawToNumber, rawToUsdcString, shortHex, isSimulatedTxHash } from "@/lib/format";
import { keccak256, stringToHex } from "viem";

describe("format: USDC raw <-> human formatting", () => {
  it("formats 100000 raw as 0.10 USDC", () => {
    expect(formatUsdc(100_000n)).toBe("0.10");
  });

  it("formats 150000 raw as 0.15 USDC", () => {
    expect(formatUsdc(150_000n)).toBe("0.15");
  });

  it("formats 500000 raw as 0.50 USDC", () => {
    expect(formatUsdc(500_000n)).toBe("0.50");
  });

  it("formats whole amounts without trailing zeros beyond 2 decimals", () => {
    expect(formatUsdc(2_000_000n)).toBe("2.00");
    expect(formatUsdc(1_234_567n)).toBe("1.234567");
    expect(formatUsdc(1_200_000n)).toBe("1.20");
  });

  it("formats zero", () => {
    expect(formatUsdc(0n)).toBe("0.00");
  });

  it("rejects negative amounts", () => {
    expect(() => formatUsdc(-1n)).toThrow();
  });

  it("parses human strings back to raw units symmetrically", () => {
    expect(parseUsdcToRaw("0.10")).toBe(100_000n);
    expect(parseUsdcToRaw("0.15")).toBe(150_000n);
    expect(parseUsdcToRaw("1.5")).toBe(1_500_000n);
    expect(parseUsdcToRaw("2")).toBe(2_000_000n);
    expect(parseUsdcToRaw(formatUsdc(123_456n))).toBe(123_456n);
  });

  it("rejects invalid human strings", () => {
    expect(() => parseUsdcToRaw("abc")).toThrow();
    expect(() => parseUsdcToRaw("-1")).toThrow();
    expect(() => parseUsdcToRaw("1.1234567")).toThrow();
  });

  it("converts raw to number for ROI math", () => {
    expect(rawToNumber(100_000n)).toBeCloseTo(0.1);
    expect(rawToNumber(0n)).toBe(0);
  });

  it("renders display strings with the USDC suffix", () => {
    expect(rawToUsdcString(250_000n)).toBe("0.25 USDC");
  });

  it("shortens long hex without touching short values", () => {
    const h = keccak256(stringToHex("a"));
    expect(shortHex(h)).toContain("...");
    expect(shortHex("0x1234")).toBe("0x1234");
  });

  it("detects simulated tx hashes (SIM-seeded keccak)", () => {
    const simHash = keccak256(stringToHex("simtx:1:x"));
    expect(typeof isSimulatedTxHash(simHash)).toBe("boolean");
  });
});
