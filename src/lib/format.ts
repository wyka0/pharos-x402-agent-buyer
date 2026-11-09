/**
 * USDC formatting helpers.
 *
 * All monetary math in this project is done in raw integer units
 * (6 decimals for Atlantic USDC) using bigint. Formatting happens only at the
 * presentation boundary.
 */

export const USDC_DECIMALS = 6;

const RAW_PER_USDC = 1_000_000n;

/** Format raw units (bigint) as a human-readable USDC string, e.g. 100000n -> "0.10". */
export function formatUsdc(raw: bigint, decimals: number = USDC_DECIMALS): string {
  if (raw < 0n) throw new Error("formatUsdc: negative amounts are not supported");
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  let fracStr = frac.toString().padStart(decimals, "0");
  // Keep at least 2 fractional digits ("0.10" not "0.1"), trim beyond 6.
  if (fracStr.length > decimals) fracStr = fracStr.slice(0, decimals);
  while (fracStr.length > 2 && fracStr.endsWith("0")) fracStr = fracStr.slice(0, -1);
  return `${whole.toString()}.${fracStr}`;
}

/** Parse a human USDC string ("0.10", "0.15", "1.5", "2") into raw units. */
export function parseUsdcToRaw(usdc: string, decimals: number = USDC_DECIMALS): bigint {
  const trimmed = usdc.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error(`parseUsdcToRaw: invalid USDC amount "${usdc}"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole || "0") * RAW_PER_USDC + BigInt(fracPadded || "0");
}

/** Number of whole USDC as a float — only for scoring/ROI math, never for accounting. */
export function rawToNumber(raw: bigint, decimals: number = USDC_DECIMALS): number {
  return Number(raw) / Number(10n ** BigInt(decimals));
}

export function rawToUsdcString(raw: bigint): string {
  return `${formatUsdc(raw)} USDC`;
}

export function shortHex(value: string, head = 8, tail = 6): string {
  if (!value.startsWith("0x")) return value;
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, 2 + head)}...${value.slice(-tail)}`;
}

/** Deterministic "SIM"-prefixed display marker for simulated (non on-chain) settlements. */
export function isSimulatedTxHash(txHash: string): boolean {
  return txHash.startsWith("0x53494d"); // keccak-derived hashes seeded with "simtx:" start with "SIM" bytes
}
