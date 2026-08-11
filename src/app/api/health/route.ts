import { NextResponse } from "next/server";
import { storageMode } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "twinpass-web",
    storage: storageMode(),
    timestamp: new Date().toISOString(),
  });
}
