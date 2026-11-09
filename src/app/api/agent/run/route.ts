import { NextResponse, type NextRequest } from "next/server";
import { runPrebuiltTask, type TaskKind } from "@/lib/agent/factory";
import { serializeTaskResult } from "@/lib/serialize";

interface RunBody {
  task?: TaskKind;
  mode?: "simulated" | "live";
  faults?: boolean;
  taskRunId?: string;
  dryRun?: boolean;
}

/** Unified agent runner: Demo A, Demo B, or the Smart-ROI plan. */
export async function POST(req: NextRequest) {
  let body: RunBody = {};
  try {
    body = (await req.json()) as RunBody;
  } catch {
    body = {};
  }
  const kind: TaskKind = body.task === "B" ? "B" : body.task === "SMART" ? "SMART" : "A";
  const mode = body.mode === "live" ? "live" : "simulated";
  try {
    const result = await runPrebuiltTask(kind, {
      baseUrl: req.nextUrl.origin,
      mode,
      faults: body.faults,
      taskRunId: body.taskRunId,
      maxDeliveryAttempts: body.dryRun ? 1 : undefined,
    });
    return NextResponse.json(serializeTaskResult(result));
  } catch (e) {
    return NextResponse.json({ error: "run_failed", message: String(e) }, { status: 500 });
  }
}
