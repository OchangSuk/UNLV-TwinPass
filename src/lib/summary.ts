import type { AttendanceEvent } from "./domain";

export function summarize(events: AttendanceEvent[]) {
  const accepted = events.filter((event) => event.decision === "ACCEPT");
  const rejected = events.length - accepted.length;
  const uniquePeople = new Set(accepted.map((event) => event.person_id)).size;
  const averageInference = events.length
    ? Math.round(events.reduce((sum, event) => sum + (event.inference_ms ?? 0), 0) / events.length)
    : 0;
  return {
    total: events.length,
    accepted: accepted.length,
    rejected,
    unique_people: uniquePeople,
    acceptance_rate: events.length ? accepted.length / events.length : 0,
    average_inference_ms: averageInference,
  };
}
