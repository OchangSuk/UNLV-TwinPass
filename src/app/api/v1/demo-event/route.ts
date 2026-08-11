import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { deviceEventSchema, toAttendanceEvent } from "@/lib/domain";
import { saveEvent } from "@/lib/store";

const demoResultSchema = z.object({
  person_id: z.union([
    z.literal("Sihoon"),
    z.literal("changsuk"),
    z.literal("Catherine"),
    z.literal("seoyeon"),
    z.literal("OTHER"),
  ]),
  vision_verified: z.boolean(),
  voice_verified: z.boolean(),
  vision_confidence: z.number().min(0).max(1).nullable(),
  voice_confidence: z.number().min(0).max(1).nullable(),
}).strict();

export async function POST(request: Request) {
  try {
    const result = demoResultSchema.parse(await request.json());
    const input = deviceEventSchema.parse({
      event_id: crypto.randomUUID(),
      device_id: "WEB-DEMO-01",
      ...result,
      detected_at: new Date().toISOString(),
      inference_ms: result.voice_verified ? 684 : 312,
      firmware_version: "web-demo-0.1.0",
    });
    const saved = await saveEvent(toAttendanceEvent(input));
    return NextResponse.json({ event: saved.event }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "invalid_payload", issues: error.issues }, { status: 400 });
    }
    console.error("Failed to save demo event", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
