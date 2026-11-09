import { NextResponse, type NextRequest } from "next/server";
import { runPrebuiltTask } from "@/lib/agent/factory";
import { serializeTaskResult } from "@/lib/serialize";

/**
 * Demo Task A (Requirement 05): completes within budget with an idempotent
 * safe-retry proof. Default mode is simulated (zero token risk); pass
 * { "mode": "live" } to settle with real Atlantic USDC.
 */
export async function POST(req: NextRequest) {
  let body: { mode?: "simulated" | "live"; faults?: boolean; taskRunId?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  try {
    const result = await runPrebuiltTask("A", {
      baseUrl: req.nextUrl.origin,
      mode: body.mode === "live" ? "live" : "simulated",
      faults: body.faults,
      taskRunId: body.taskRunId,
    });
    return NextResponse.json(serializeTaskResult(result));
  } catch (e) {
    return NextResponse.json({ error: "run_failed", message: String(e) }, { status: 500 });
  }
}
