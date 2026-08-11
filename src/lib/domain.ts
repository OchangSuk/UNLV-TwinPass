import { z } from "zod";

export const registeredPersonIds = ["Sihoon", "changsuk", "Catherine", "seoyeon"] as const;
export const personIds = [...registeredPersonIds, "OTHER"] as const;

export const deviceEventSchema = z
  .object({
    event_id: z.string().uuid(),
    device_id: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/),
    person_id: z.union([
      z.literal("Sihoon"),
      z.literal("changsuk"),
      z.literal("Catherine"),
      z.literal("seoyeon"),
      z.literal("OTHER"),
    ]),
    vision_verified: z.boolean(),
    voice_verified: z.boolean(),
    vision_confidence: z.number().min(0).max(1).nullable().optional(),
    voice_confidence: z.number().min(0).max(1).nullable().optional(),
    detected_at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Invalid ISO timestamp"),
    inference_ms: z.number().int().min(0).max(120_000).optional(),
    firmware_version: z.string().trim().max(40).optional(),
    decision: z.union([z.literal("ACCEPT"), z.literal("REJECT")]).optional(),
  })
  .strict();

export type DeviceEventInput = z.infer<typeof deviceEventSchema>;
export type Decision = "ACCEPT" | "REJECT";

export type AttendanceEvent = Omit<DeviceEventInput, "decision"> & {
  decision: Decision;
  received_at: string;
};

export function deriveDecision(input: DeviceEventInput): Decision {
  return input.person_id !== "OTHER" &&
    input.vision_verified &&
    input.voice_verified
    ? "ACCEPT"
    : "REJECT";
}

export function toAttendanceEvent(input: DeviceEventInput): AttendanceEvent {
  const payload = { ...input };
  delete payload.decision;
  return {
    ...payload,
    vision_confidence: payload.vision_confidence ?? null,
    voice_confidence: payload.voice_confidence ?? null,
    decision: deriveDecision(input),
    received_at: new Date().toISOString(),
  };
}
