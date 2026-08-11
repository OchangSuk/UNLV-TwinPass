import { neon } from "@neondatabase/serverless";
import { personIds, type AttendanceEvent } from "./domain";

type SaveResult = { event: AttendanceEvent; created: boolean };

const demoEvents: AttendanceEvent[] = [
  {
    event_id: "8e1d7414-7328-4d67-8df4-10e587a9e201",
    device_id: "NICLA-ENTRY-01",
    person_id: "changsuk",
    vision_verified: true,
    voice_verified: true,
    vision_confidence: 0.96,
    voice_confidence: 0.93,
    detected_at: new Date(Date.now() - 7 * 60_000).toISOString(),
    received_at: new Date(Date.now() - 7 * 60_000 + 900).toISOString(),
    inference_ms: 684,
    firmware_version: "0.1.0",
    decision: "ACCEPT",
  },
  {
    event_id: "07a20156-c59a-481a-a15c-32bd44c22002",
    device_id: "NICLA-ENTRY-01",
    person_id: "Sihoon",
    vision_verified: true,
    voice_verified: false,
    vision_confidence: 0.91,
    voice_confidence: 0.42,
    detected_at: new Date(Date.now() - 19 * 60_000).toISOString(),
    received_at: new Date(Date.now() - 19 * 60_000 + 1100).toISOString(),
    inference_ms: 721,
    firmware_version: "0.1.0",
    decision: "REJECT",
  },
  {
    event_id: "33e8401a-c705-4c29-a29e-cbc1849d2003",
    device_id: "NICLA-ENTRY-01",
    person_id: "OTHER",
    vision_verified: false,
    voice_verified: false,
    vision_confidence: 0.28,
    voice_confidence: null,
    detected_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    received_at: new Date(Date.now() - 31 * 60_000 + 650).toISOString(),
    inference_ms: 188,
    firmware_version: "0.1.0",
    decision: "REJECT",
  },
];

declare global {
  var twinPassEvents: AttendanceEvent[] | undefined;
}

function memoryEvents() {
  if (!globalThis.twinPassEvents) globalThis.twinPassEvents = [...demoEvents];
  const validPersonIds = new Set<string>(personIds);
  globalThis.twinPassEvents = globalThis.twinPassEvents.filter((event) => validPersonIds.has(event.person_id));
  return globalThis.twinPassEvents;
}

function database() {
  return process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
}

function mapRow(row: Record<string, unknown>): AttendanceEvent {
  return {
    event_id: String(row.event_id),
    device_id: String(row.device_id),
    person_id: String(row.person_id) as AttendanceEvent["person_id"],
    vision_verified: Boolean(row.vision_verified),
    voice_verified: Boolean(row.voice_verified),
    vision_confidence: row.vision_confidence === null ? null : Number(row.vision_confidence),
    voice_confidence: row.voice_confidence === null ? null : Number(row.voice_confidence),
    detected_at: new Date(String(row.detected_at)).toISOString(),
    received_at: new Date(String(row.received_at)).toISOString(),
    inference_ms: row.inference_ms === null ? undefined : Number(row.inference_ms),
    firmware_version: row.firmware_version === null ? undefined : String(row.firmware_version),
    decision: String(row.decision) as AttendanceEvent["decision"],
  };
}

export async function saveEvent(event: AttendanceEvent): Promise<SaveResult> {
  const sql = database();
  if (!sql) {
    const events = memoryEvents();
    const existing = events.find((item) => item.event_id === event.event_id);
    if (existing) return { event: existing, created: false };
    events.unshift(event);
    return { event, created: true };
  }

  const rows = await sql.query(
    `INSERT INTO attendance_events (
      event_id, device_id, person_id, vision_verified, voice_verified,
      vision_confidence, voice_confidence, detected_at, received_at,
      inference_ms, firmware_version, decision
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (event_id) DO NOTHING RETURNING *`,
    [event.event_id, event.device_id, event.person_id, event.vision_verified,
      event.voice_verified, event.vision_confidence, event.voice_confidence,
      event.detected_at, event.received_at, event.inference_ms ?? null,
      event.firmware_version ?? null, event.decision],
  );
  if (rows.length) return { event: mapRow(rows[0] as Record<string, unknown>), created: true };
  const existing = await sql.query(
    "SELECT * FROM attendance_events WHERE event_id = $1 LIMIT 1",
    [event.event_id],
  );
  return { event: mapRow(existing[0] as Record<string, unknown>), created: false };
}

export async function listEvents(limit = 50): Promise<AttendanceEvent[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const sql = database();
  if (!sql) return memoryEvents().slice(0, safeLimit);
  const rows = await sql.query(
    "SELECT * FROM attendance_events ORDER BY received_at DESC LIMIT $1",
    [safeLimit],
  );
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

export function storageMode() {
  return process.env.DATABASE_URL ? "postgres" : "memory";
}
