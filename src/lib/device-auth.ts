import { timingSafeEqual } from "node:crypto";

function configuredKey() {
  const key = process.env.DEVICE_API_KEY;
  if (key) return key;
  if (process.env.NODE_ENV !== "production") return "dev-twinpass-key";
  throw new Error("DEVICE_API_KEY is not configured");
}

export function isAuthorizedDevice(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const expected = configuredKey();
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer);
}
