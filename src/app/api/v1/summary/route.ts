import { NextResponse } from "next/server";
import { listEvents } from "@/lib/store";
import { summarize } from "@/lib/summary";

export const dynamic = "force-dynamic";

export async function GET() {
  const events = await listEvents(200);
  return NextResponse.json(summarize(events), {
    headers: { "Cache-Control": "no-store" },
  });
}
