import { describe, it, expect, beforeEach } from "vitest";
import { serveX402 } from "@/lib/server/x402Endpoint";
import { decodePaymentRequired, decodePaymentResponse, PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER, IDEMPOTENCY_KEY_HEADER, encodePaymentPayload } from "@/lib/x402";
import { ENDPOINT_SPECS } from "@/lib/server/catalog";
import { makeWorld, buildPaidPayload, BASE } from "./helpers";
import { NETWORK_ID, CHAIN_ID } from "@/lib/chain";

let world: ReturnType<typeof makeWorld>;
beforeEach(() => {
  world = makeWorld();
});

function endpointDeps(path: keyof typeof ENDPOINT_SPECS) {
  return {
    spec: ENDPOINT_SPECS[path],
    verifierFor: () => world.verifier,
    network: NETWORK_ID,
    chainId: CHAIN_ID,
    asset: "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B",
    payTo: "0xB0f7681668f916eEd97dA066D31aA295D34727c0",
  };
}

const PATHS = ["/api/x402/security-audit", "/api/x402/whale-telemetry", "/api/x402/mev-simulation", "/api/x402/institutional-alpha"] as const;

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return world.dispatch(new Request(`${BASE}${path}`, { headers }));
}

describe("x402 endpoints — Step 1: HTTP 402 challenge", () => {
  it.each(PATHS)("returns 402 with a decodable PAYMENT-REQUIRED header for %s", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(402);
    const raw = res.headers.get(PAYMENT_REQUIRED_HEADER);
    expect(raw).toBeTruthy();
    const decoded = decodePaymentRequired(raw!);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toHaveLength(1);
  });

  it("prices each endpoint exactly as specified", async () => {
    const expected: Record<string, string> = {
      "/api/x402/security-audit": "100000",
      "/api/x402/whale-telemetry": "150000",
      "/api/x402/mev-simulation": "200000",
      "/api/x402/institutional-alpha": "500000",
    };
    for (const path of PATHS) {
      const res = await get(path);
      const decoded = decodePaymentRequired(res.headers.get(PAYMENT_REQUIRED_HEADER)!);
      expect(decoded.accepts[0].maxAmountRequired).toBe(expected[path]);
    }
  });

  it("binds the challenge to the absolute resource URL and payTo", async () => {
    const res = await get("/api/x402/security-audit");
    const decoded = decodePaymentRequired(res.headers.get(PAYMENT_REQUIRED_HEADER)!);
    expect(decoded.accepts[0].resource).toBe(`${BASE}/api/x402/security-audit`);
    expect(decoded.accepts[0].payTo).toBe("0xB0f7681668f916eEd97dA066D31aA295D34727c0");
    expect(decoded.accepts[0].network).toBe("eip155:688689");
    expect(decoded.accepts[0].asset).toBe("0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B");
    expect(decoded.accepts[0].extra.chainId).toBe(688689);
  });

  it("issues a fresh nonce per challenge", async () => {
    const r1 = await get("/api/x402/security-audit");
    const r2 = await get("/api/x402/security-audit");
    const d1 = decodePaymentRequired(r1.headers.get(PAYMENT_REQUIRED_HEADER)!);
    const d2 = decodePaymentRequired(r2.headers.get(PAYMENT_REQUIRED_HEADER)!);
    expect(d1.accepts[0].extra.nonce).not.toBe(d2.accepts[0].extra.nonce);
  });

  it("sets cache-control: no-store and the payment network header", async () => {
    const res = await get("/api/x402/security-audit");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-payment-network")).toBe("eip155:688689");
  });

  it("returns a JSON body describing the payment requirement", async () => {
    const res = await get("/api/x402/security-audit");
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("payment_required");
    expect(body.message).toContain("PAYMENT-SIGNATURE");
  });
});

describe("x402 endpoints — Step 3/4: paid retry and delivery", () => {
  it("returns 200 + data + PAYMENT-RESPONSE for a valid paid retry", async () => {
    const path = "/api/x402/security-audit";
    const { payload, intentId } = await buildPaidPayload(world, path);
    const res = await get(path, {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentPayload(payload),
      [IDEMPOTENCY_KEY_HEADER]: intentId,
    });
    expect(res.status).toBe(200);
    const raw = res.headers.get(PAYMENT_RESPONSE_HEADER);
    expect(raw).toBeTruthy();
    const decoded = decodePaymentResponse(raw!);
    expect(decoded.settlement.success).toBe(true);
    expect(decoded.settlement.txHash).toBe(payload.txHash);
    expect(decoded.settlement.amount).toBe("100000");
    expect(decoded.receipt.intentId).toBe(intentId);
    expect(decoded.receipt.replay).toBe(false);
    expect(res.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(intentId);
    const body = (await res.json()) as { data: Record<string, unknown>; paidWith: { replay: boolean } };
    expect(body.paidWith.replay).toBe(false);
    expect(body.data).toHaveProperty("riskScore");
    expect(body.data).toHaveProperty("findings");
  });

  it("re-presenting the same paid proof returns 200 with replay=true (no double charge)", async () => {
    const path = "/api/x402/whale-telemetry";
    const { payload, intentId } = await buildPaidPayload(world, path);
    const headers = { [PAYMENT_SIGNATURE_HEADER]: encodePaymentPayload(payload), [IDEMPOTENCY_KEY_HEADER]: intentId };
    const first = await get(path, headers);
    expect(first.status).toBe(200);
    const replay = await get(path, headers);
    expect(replay.status).toBe(200);
    const decoded = decodePaymentResponse(replay.headers.get(PAYMENT_RESPONSE_HEADER)!);
    expect(decoded.receipt.replay).toBe(true);
    expect(decoded.settlement.txHash).toBe(payload.txHash);
    expect(decoded.settlement.blockNumber).toBe((await decodePaymentResponse(first.headers.get(PAYMENT_RESPONSE_HEADER)!)).settlement.blockNumber);
    // exactly one settlement exists on the (simulated) chain for this intent
    const settlements = world.sim.all().filter((t) => t.intentId === intentId);
    expect(settlements).toHaveLength(1);
  });

  it("rejects an Idempotency-Key that does not match payload.intentId", async () => {
    const path = "/api/x402/security-audit";
    const { payload } = await buildPaidPayload(world, path);
    const res = await get(path, {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentPayload(payload),
      [IDEMPOTENCY_KEY_HEADER]: "0x" + "ff".repeat(32),
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("x-x402-error")).toBe("IDEMPOTENCY_KEY_MISMATCH");
  });

  it("rejects an undecodable PAYMENT-SIGNATURE header", async () => {
    const res = await get("/api/x402/security-audit", { [PAYMENT_SIGNATURE_HEADER]: "%%%not-base64%%%" });
    expect(res.status).toBe(402);
    expect(res.headers.get("x-x402-error")).toBe("UNDECODABLE_PAYMENT_PAYLOAD");
  });

  it("rejects a structurally valid but tampered payload (commitment mismatch)", async () => {
    const path = "/api/x402/security-audit";
    const { payload } = await buildPaidPayload(world, path);
    const tampered = { ...payload, txHash: ("0x" + "e0".repeat(32)) as `0x${string}` };
    const res = await get(path, { [PAYMENT_SIGNATURE_HEADER]: encodePaymentPayload(tampered) });
    expect(res.status).toBe(402);
    expect(res.headers.get("x-x402-error")).toBe("SETTLEMENT_COMMITMENT_MISMATCH");
    // and it re-issues a fresh challenge
    expect(res.headers.get(PAYMENT_REQUIRED_HEADER)).toBeTruthy();
  });

  it("delivers deterministic data for the same challenge nonce", async () => {
    const path = "/api/x402/whale-telemetry";
    const { payload, intentId } = await buildPaidPayload(world, path);
    const headers = { [PAYMENT_SIGNATURE_HEADER]: encodePaymentPayload(payload), [IDEMPOTENCY_KEY_HEADER]: intentId };
    const r1 = (await (await get(path, headers)).json()) as { data: { topHolderConcentrationPct: number } };
    const r2 = (await (await get(path, headers)).json()) as { data: { topHolderConcentrationPct: number } };
    expect(r1.data.topHolderConcentrationPct).toBe(r2.data.topHolderConcentrationPct);
  });

  it("serves distinct data shapes per endpoint", async () => {
    const shapes: Record<string, string[]> = {
      "/api/x402/security-audit": ["riskScore", "findings", "bytecodeHash"],
      "/api/x402/whale-telemetry": ["topHolders", "liquidityFlow", "topHolderConcentrationPct"],
      "/api/x402/mev-simulation": ["slippageBps", "sandwichRiskScore", "recommendedMaxTradeUSDC"],
      "/api/x402/institutional-alpha": ["signals", "confidential"],
    };
    for (const path of PATHS) {
      const { payload, intentId } = await buildPaidPayload(world, path, { intentSeed: `shape-${path}` });
      const res = await get(path, { [PAYMENT_SIGNATURE_HEADER]: encodePaymentPayload(payload), [IDEMPOTENCY_KEY_HEADER]: intentId });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown> };
      for (const key of shapes[path]) {
        expect(body.data).toHaveProperty(key);
      }
    }
  });

  it("the trap endpoint marks itself as an intentional over-cap probe", async () => {
    const path = "/api/x402/institutional-alpha";
    const { payload, intentId } = await buildPaidPayload(world, path, { intentSeed: "trap" });
    const res = await get(path, { [PAYMENT_SIGNATURE_HEADER]: encodePaymentPayload(payload), [IDEMPOTENCY_KEY_HEADER]: intentId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { note: string } };
    expect(body.data.note).toContain("per-call cap");
  });

  it("returns 404 for unknown paths through the dispatcher", async () => {
    const res = await get("/api/x402/does-not-exist");
    expect(res.status).toBe(404);
  });
});
