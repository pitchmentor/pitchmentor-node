# @pitchmentor/sdk

[![npm](https://img.shields.io/npm/v/@pitchmentor/sdk?logo=npm&color=cb3837)](https://www.npmjs.com/package/@pitchmentor/sdk) [![CI](https://github.com/pitchmentor/pitchmentor-node/actions/workflows/ci.yml/badge.svg)](https://github.com/pitchmentor/pitchmentor-node/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Official TypeScript / JavaScript SDK for the [Pitch Mentor](https://pitchmentor.net) API (`https://api.pitchmentor.net/v1`).
Zero runtime dependencies; runs on Node 20+, Deno, Bun and browsers (uses `fetch` and Web Crypto).

API reference: https://pitchmentor.net/docs

## Install

```bash
npm install @pitchmentor/sdk
```

## Authentication

Create a team API key (`pm_live_…`) in the Pitch Mentor dashboard. It is sent as `Authorization: Bearer pm_live_…`.
The client reads `PITCHMENTOR_API_KEY` (and optionally `PITCHMENTOR_BASE_URL`) from the environment, or takes them as options.
Each key has scopes (`calls:read`, `leads:write`, …); every method's doc comment names the scope it needs.

```ts
import { PitchMentor } from "@pitchmentor/sdk";

const pm = new PitchMentor(); // or new PitchMentor({ apiKey: "pm_live_…" })
```

## Quick start

```ts
const me = await pm.getMe();
const { call, coachingLogs } = await pm.getCall("call_id");
const overview = await pm.getAnalyticsOverview({ period: "30d" });
const perMember = await pm.getAnalyticsByMember({ period: "30d" });
await pm.upsertLead({ name: "Ada Lovelace", externalId: "crm-42", email: "ada@example.com" });
await pm.updateTeamConfig({ toneGuidelines: "Friendly, concise." });
const team = await pm.getTeamConfig();
const billing = await pm.getBillingStatus();
const usage = await pm.listMemberUsage();
const referrals = await pm.getReferralStats();
const csv = await pm.exportCalls({ format: "csv" });
```

Every API operation is a method named after its `operationId` (`listCalls`, `getCall`, `createWebhookEndpoint`, …),
with typed parameters and responses. `pm.request(method, path, { query, body })` reaches endpoints newer than the SDK.

## Pagination

List methods return one page: `{ data, has_more, next_cursor }`. Pass `next_cursor` as `cursor` for the next page,
or use the `…Iter` method, which walks every page:

```ts
const page = await pm.listCalls({ period: "7d", limit: 50 });
for await (const call of pm.listCallsIter({ period: "7d" })) {
  console.log(call.id, call.prospectName, call.callScore);
}
```

Paginated: `listCalls`, `listLeads`, `listApiKeys`, `listWebhookEndpoints`, `listWebhookDeliveries`.

## Retries, timeouts and idempotency

429, 5xx and network errors are retried (default 2 times) with exponential backoff, honoring `retry-after`.
Every POST carries an `Idempotency-Key`, generated unless you pass one and reused across retries, so a retried POST never
runs twice. Pass your own key to make a POST safe to repeat across processes:

```ts
const pm = new PitchMentor({ maxRetries: 3, timeoutMs: 30_000 });
await pm.upsertLead({ name: "Ada", externalId: "crm-42" }, { idempotencyKey: "import-42" });
// per request: { idempotencyKey, maxRetries, timeoutMs, signal, headers } as the last argument
```

Client options: `apiKey`, `baseUrl`, `maxRetries` (2), `timeoutMs` (60000, per attempt), `fetch`.

## Errors

Non-2xx responses throw a `PitchMentorError` subclass carrying `status`, `code` (machine-readable, e.g. `not_found`,
`insufficient_scope`), `message`, `headers` and `body`: `BadRequestError` (400), `AuthenticationError` (401),
`PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `UnprocessableEntityError` (422),
`RateLimitError` (429, has `retryAfter` seconds), `InternalServerError` (5xx). A request that never got a response
throws `ConnectionError`.

```ts
import { NotFoundError, PitchMentorError } from "@pitchmentor/sdk";

try {
  await pm.getCall("missing");
} catch (err) {
  if (err instanceof NotFoundError) console.log("no such call");
  else if (err instanceof PitchMentorError) console.log(err.status, err.code, err.message);
  else throw err;
}
```

## Webhooks

Webhooks are signed with [Standard Webhooks](https://www.standardwebhooks.com/) (`webhook-id`, `webhook-timestamp`,
`webhook-signature`). `verifyWebhook` checks the signature against your endpoint's `whsec_…` secret, rejects timestamps
older than 5 minutes, and returns the typed event. Always pass the raw request body, exactly as received.

```ts
import express from "express";
import { verifyWebhook, WebhookVerificationError } from "@pitchmentor/sdk";

app.post("/hooks/pitchmentor", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = await verifyWebhook(process.env.PITCHMENTOR_WEBHOOK_SECRET!, req.headers, req.body.toString());
    if (event.type === "call.completed") console.log(event.data.id);
    res.sendStatus(204);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.sendStatus(400);
    throw err;
  }
});
```

## Development

```bash
npm install
npm test          # build + node:test
```

### Regenerating from the API

`src/generated.ts` is generated by [`codegen/generate.mjs`](codegen/generate.mjs) from [`openapi.json`](openapi.json), a copy of the
live spec at https://api.pitchmentor.net/v1/openapi.json. Don't edit it by hand:

```bash
npm run regen          # download the live spec and regenerate (needs curl and Node 20+)
node codegen/generate.mjs    # regenerate from the committed openapi.json (after changing the generator)
```

Everything else (transport, retries, errors, pagination, webhooks) is hand-written. The weekly
[Regen workflow](.github/workflows/regen.yml) runs the same script and opens a pull request when the live spec changes.

## Releasing

1. Bump the version in `package.json` and `VERSION` in `src/client.ts` (`scripts/check-version.sh X.Y.Z` checks both), merge to `main`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`. The [Release workflow](.github/workflows/release.yml) tests, publishes to npm
   with provenance and creates the GitHub Release.
3. Bump the `@pitchmentor/sdk` dependency in [pitchmentor-cli](https://github.com/pitchmentor/pitchmentor-cli) and
   [pitchmentor-mcp](https://github.com/pitchmentor/pitchmentor-mcp) to pick up new operations.

## Support

[Docs](https://pitchmentor.net/docs) · [Status](https://pitchmentor.net/status) · [Discord](https://discord.gg/SkcxVEJ6wQ). Security issues: see the [security policy](https://github.com/pitchmentor/.github/blob/main/SECURITY.md).

## License

[MIT](LICENSE)
