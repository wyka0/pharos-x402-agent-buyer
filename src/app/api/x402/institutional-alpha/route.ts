import type { NextRequest } from "next/server";
import { serveX402 } from "@/lib/server/x402Endpoint";
import { getEndpointDeps } from "@/lib/server/runtime";

/**
 * Over-cap TRAP endpoint: priced at 0.50 USDC — above every demo per-call cap —
 * so the buyer agent exercises its hard refusal (REFUSED_OVER_PER_CALL_CAP)
 * before signing anything.
 */
export async function GET(req: NextRequest) {
  return serveX402(req, getEndpointDeps("/api/x402/institutional-alpha"));
}
