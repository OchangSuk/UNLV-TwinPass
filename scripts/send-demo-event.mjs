const endpoint = process.env.TWINPASS_API_URL ?? "http://localhost:3000/api/v1/events";
const apiKey = process.env.DEVICE_API_KEY ?? "dev-twinpass-key";
const labels = new Map([
  ["sihoon", "Sihoon"],
  ["changsuk", "changsuk"],
  ["catherine", "Catherine"],
  ["seoyeon", "seoyeon"],
  ["other", "OTHER"],
]);
const requestedLabel = (process.argv[2] ?? "changsuk").toLowerCase();
const personId = labels.get(requestedLabel);
if (!personId) {
  console.error("Unknown label. Use Sihoon, changsuk, Catherine, seoyeon, or OTHER.");
  process.exit(1);
}
const accepted = personId !== "OTHER" && process.argv[3] !== "reject";

const payload = {
  event_id: crypto.randomUUID(),
  device_id: "NICLA-ENTRY-01",
  person_id: personId,
  vision_verified: personId !== "OTHER",
  voice_verified: accepted,
  vision_confidence: personId === "OTHER" ? 0.31 : 0.96,
  voice_confidence: personId === "OTHER" ? null : accepted ? 0.93 : 0.41,
  detected_at: new Date().toISOString(),
  inference_ms: accepted ? 684 : 512,
  firmware_version: "0.1.0",
  decision: accepted ? "ACCEPT" : "REJECT",
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(payload),
});

console.log(`${response.status} ${response.statusText}`);
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
