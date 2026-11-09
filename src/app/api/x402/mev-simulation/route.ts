import type { NextRequest } from "next/server";
import { serveX402 } from "@/lib/server/x402Endpoint";
import { getEndpointDeps } from "@/lib/server/runtime";

export async function GET(req: NextRequest) {
  return serveX402(req, getEndpointDeps("/api/x402/mev-simulation"));
}
