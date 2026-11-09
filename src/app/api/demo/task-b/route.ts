import { NextResponse, type NextRequest } from "next/server";
import { runPrebuiltTask } from "@/lib/agent/factory";
import { serializeTaskResult } from "@/lib/serialize";

/**
 * Demo Task B (Requirement 05): halts gracefully on budget/cap limits with an
 * exact refusal audit log. Default mode is simulated; pass { "mode": "live" }
 * for real Atlantic USDC settlement of the single affordable call.
 */
export async function POST(req: NextRequest) {
  let body: { mode?: "simulated" | "live"; taskRunId?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  try {
    const result = await runPrebuiltTask("B", {
      baseUrl: req.nextUrl.origin,
      mode: body.mode === "live" ? "live" : "simulated",
      taskRunId: body.taskRunId,
    });
    return NextResponse.json(serializeTaskResult(result));
  } catch (e) {
    return NextResponse.json({ error: "run_failed", message: String(e) }, { status: 500 });
  }
}
