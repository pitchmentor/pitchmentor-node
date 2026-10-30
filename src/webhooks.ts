import type { WebhookEvent } from "./generated.js";

export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
}

export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export interface VerifyOptions {
  /** Max age of `webhook-timestamp`, in seconds. Default 300. */
  toleranceSec?: number;
  /** Current time in seconds (tests). */
  now?: number;
}

/**
 * Verifies a Pitch Mentor webhook (Standard Webhooks: `webhook-id`, `webhook-timestamp`,
 * `webhook-signature: v1,<base64 HMAC-SHA256>`) and returns the parsed event.
 * Pass the raw request body, exactly as received. Throws WebhookVerificationError.
 */
export async function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string | Uint8Array,
  options: VerifyOptions = {}
): Promise<WebhookEvent> {
  const header = (name: string) => {
    const v = headers instanceof Headers ? headers.get(name) : (headers[name] ?? headers[name.toLowerCase()]);
    return Array.isArray(v) ? v[0] : (v ?? undefined);
  };
  const id = header("webhook-id");
  const timestamp = header("webhook-timestamp");
  const signatures = header("webhook-signature");
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature header");

  const ts = Number(timestamp);
  const now = options.now ?? Date.now() / 1000;
  if (!Number.isInteger(ts) || Math.abs(now - ts) > (options.toleranceSec ?? 300)) {
    throw new WebhookVerificationError("Webhook timestamp is missing or outside the tolerance window");
  }

  const payload = typeof body === "string" ? body : new TextDecoder().decode(body);
  const key = await crypto.subtle.importKey("raw", base64Decode(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${payload}`);
  for (const part of signatures.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = base64Decode(sig);
    } catch {
      continue;
    }
    // subtle.verify compares in constant time
    if (await crypto.subtle.verify("HMAC", key, bytes, signed)) {
      try {
        return JSON.parse(payload) as WebhookEvent;
      } catch {
        throw new WebhookVerificationError("Webhook body is not valid JSON");
      }
    }
  }
  throw new WebhookVerificationError("No matching webhook signature");
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
