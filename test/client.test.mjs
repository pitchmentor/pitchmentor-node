import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PitchMentor,
  NotFoundError,
  RateLimitError,
  AuthenticationError,
  ConnectionError,
  verifyWebhook,
  WebhookVerificationError,
  operations,
} from "../dist/index.js";

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Fake fetch that records requests and replays queued responses. */
function fake(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(url), ...init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fn, calls };
}
const client = (f, opts = {}) => new PitchMentor({ apiKey: "pm_live_test", baseUrl: "http://api.test/", fetch: f.fn, ...opts });

test("builds GET requests: auth, path escaping, query (drops undefined)", async () => {
  const f = fake(json(200, { data: [], has_more: false, next_cursor: null }));
  await client(f).listWebhookDeliveries("we/1", { status: "failed", limit: 5, cursor: undefined });
  const [c] = f.calls;
  assert.equal(c.method, "GET");
  assert.equal(c.url.pathname, "/v1/webhooks/we%2F1/deliveries");
  assert.equal(c.url.search, "?status=failed&limit=5");
  assert.equal(c.headers.Authorization, "Bearer pm_live_test");
  assert.equal(c.headers["Idempotency-Key"], undefined);
  assert.equal(c.body, undefined);
});

test("POST with body sends JSON and an auto idempotency key; bodyless POST sends no content-type", async () => {
  const f = fake(json(201, { lead: { id: "l1" }, action: "created" }), json(200, { id: "c1", archivedAt: null }));
  const pm = client(f);
  const res = await pm.upsertLead({ name: "Ada", externalId: "crm-1" });
  assert.equal(res.lead.id, "l1");
  assert.deepEqual(JSON.parse(f.calls[0].body), { name: "Ada", externalId: "crm-1" });
  assert.equal(f.calls[0].headers["Content-Type"], "application/json");
  assert.match(f.calls[0].headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);
  await pm.archiveCall("c1", { idempotencyKey: "mine" });
  assert.equal(f.calls[1].headers["Idempotency-Key"], "mine");
  assert.equal(f.calls[1].headers["Content-Type"], undefined);
});

test("auto-pagination follows next_cursor", async () => {
  const f = fake(
    json(200, { data: [{ id: "a" }, { id: "b" }], has_more: true, next_cursor: "b" }),
    json(200, { data: [{ id: "c" }], has_more: false, next_cursor: null })
  );
  const ids = [];
  for await (const call of client(f).listCallsIter({ limit: 2, period: "7d" })) ids.push(call.id);
  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.equal(f.calls[0].url.searchParams.get("cursor"), null);
  assert.equal(f.calls[1].url.searchParams.get("cursor"), "b");
  assert.equal(f.calls[1].url.searchParams.get("period"), "7d");
});

test("retries 429 honoring retry-after and 5xx, reusing the idempotency key", async () => {
  const f = fake(
    json(429, { error: { code: "rate_limited", message: "slow down" } }, { "retry-after": "0" }),
    json(503, { error: { code: "internal_error", message: "x" } }),
    json(200, { id: "c1", archivedAt: "2026-01-01T00:00:00.000Z" })
  );
  const t0 = Date.now();
  const res = await client(f).archiveCall("c1");
  assert.equal(res.id, "c1");
  assert.equal(f.calls.length, 3);
  assert.equal(new Set(f.calls.map((c) => c.headers["Idempotency-Key"])).size, 1);
  assert.ok(Date.now() - t0 < 3000);
});

test("gives up after maxRetries with a typed RateLimitError", async () => {
  const f = fake(json(429, { error: { code: "rate_limited", message: "slow" } }, { "retry-after": "7" }));
  const err = await client(f, { maxRetries: 0 }).getMe().catch((e) => e);
  assert.ok(err instanceof RateLimitError);
  assert.equal(err.status, 429);
  assert.equal(err.code, "rate_limited");
  assert.equal(err.retryAfter, 7);
});

test("parses {error:{code,message}} into typed errors and does not retry 4xx", async () => {
  const f = fake(json(404, { error: { code: "not_found", message: "Call not found" } }));
  const err = await client(f).getCall("nope").catch((e) => e);
  assert.ok(err instanceof NotFoundError);
  assert.equal(err.message, "Call not found");
  assert.equal(err.code, "not_found");
  assert.equal(f.calls.length, 1);

  const f2 = fake(new Response("bad gateway", { status: 401 }));
  const err2 = await client(f2).getMe().catch((e) => e);
  assert.ok(err2 instanceof AuthenticationError);
  assert.equal(err2.message, "bad gateway");
});

test("network errors retry, then raise ConnectionError", async () => {
  const f = fake(new TypeError("fetch failed"), new TypeError("fetch failed"));
  const err = await client(f, { maxRetries: 1 }).getMe().catch((e) => e);
  assert.ok(err instanceof ConnectionError);
  assert.equal(f.calls.length, 2);
});

test("CSV export returns text", async () => {
  const f = fake(new Response("id,createdAt\nc1,x\n", { status: 200, headers: { "content-type": "text/csv" } }));
  assert.equal(await client(f).exportCalls(), "id,createdAt\nc1,x\n");
});

test("operation metadata covers the spec", () => {
  assert.equal(Object.keys(operations).length, 42);
  // from the spec's x-destructive
  const destructive = Object.keys(operations).filter((id) => operations[id].destructive).sort();
  assert.deepEqual(destructive, ["cancelInvite", "deleteWebhookEndpoint", "removeMember", "revokeApiKey", "rotateApiKey", "rotateWebhookSecret"]);
  assert.equal(operations.listCalls.paginated, true);
});

// Known-good vector from the backend's test (test/api-v1.test.ts) = Standard Webhooks reference vector
const vector = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  ts: 1614265330,
  body: '{"test": 2432232314}',
  sig: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};
const vHeaders = (over = {}) => ({ "webhook-id": vector.id, "webhook-timestamp": String(vector.ts), "webhook-signature": vector.sig, ...over });

test("webhook verify: known-good vector, multiple signatures, Headers object", async () => {
  assert.deepEqual(await verifyWebhook(vector.secret, vHeaders(), vector.body, { now: vector.ts }), { test: 2432232314 });
  await verifyWebhook(vector.secret, vHeaders({ "webhook-signature": `v1,bogus ${vector.sig}` }), vector.body, { now: vector.ts });
  await verifyWebhook(vector.secret, new Headers(vHeaders()), new TextEncoder().encode(vector.body), { now: vector.ts + 10 });
});

test("webhook verify rejects tampering, wrong secret, wrong id and stale timestamps", async () => {
  const bad = [
    [vector.secret, vHeaders(), vector.body + " ", vector.ts],
    ["whsec_" + btoa("another secret key"), vHeaders(), vector.body, vector.ts],
    [vector.secret, vHeaders({ "webhook-id": "msg_2" }), vector.body, vector.ts],
    [vector.secret, vHeaders(), vector.body, vector.ts + 301],
    [vector.secret, vHeaders({ "webhook-signature": undefined }), vector.body, vector.ts],
  ];
  for (const [secret, headers, body, now] of bad) {
    await assert.rejects(verifyWebhook(secret, headers, body, { now }), WebhookVerificationError);
  }
});
