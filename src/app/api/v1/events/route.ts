import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { isAuthorizedDevice } from "@/lib/device-auth";
import { deriveDecision, deviceEventSchema, toAttendanceEvent } from "@/lib/domain";
import { listEvents, saveEvent } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const events = await listEvents(Number.isFinite(limit) ? limit : 50);
  return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!isAuthorizedDevice(request)) {
    return NextResponse.json(
      { error: "unauthorized", message: "Invalid device credential" },
      { status: 401 },
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 4096) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  try {
    const input = deviceEventSchema.parse(await request.json());
    const serverDecision = deriveDecision(input);
    if (input.decision && input.decision !== serverDecision) {
      return NextResponse.json(
        {
          error: "decision_mismatch",
          message: "Device decision does not match the verification fields",
          server_decision: serverDecision,
        },
        { status: 422 },
      );
    }
    const result = await saveEvent(toAttendanceEvent(input));
    return NextResponse.json(
      {
        accepted: result.event.decision === "ACCEPT",
        duplicate: !result.created,
        event: result.event,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "invalid_payload", issues: error.issues },
        { status: 400 },
      );
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_json" },
        { status: 400 },
      );
    }
    console.error("Failed to save attendance event", error);
    return NextResponse.json(
      { error: "internal_error" },
      { status: 500 },
    );
  }
}
