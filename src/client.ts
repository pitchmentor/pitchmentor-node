import { ConnectionError, errorFromResponse, parseRetryAfter, type Page, type RequestOptions } from "./core.js";
import { Operations } from "./generated.js";

export const VERSION = "0.1.1";
export const DEFAULT_BASE_URL = "https://api.pitchmentor.net";

export interface ClientOptions {
  /** Team API key (`pm_live_…`). Defaults to the `PITCHMENTOR_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to `PITCHMENTOR_BASE_URL`, else https://api.pitchmentor.net. */
  baseUrl?: string;
  /** Retries for 429, 5xx and network errors (honoring `retry-after`). Default 2. */
  maxRetries?: number;
  /** Per-attempt timeout. Default 60s. */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const MAX_RETRY_DELAY_SEC = 60;
const env = (name: string): string | undefined => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];

export class PitchMentor extends Operations {
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    super();
    const apiKey = options.apiKey ?? env("PITCHMENTOR_API_KEY");
    if (!apiKey) throw new Error("Missing API key: pass { apiKey } or set PITCHMENTOR_API_KEY.");
    this.#apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? env("PITCHMENTOR_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Sends any request to the API (for endpoints newer than this SDK). JSON responses are parsed; others return text. */
  async request<T>(method: string, path: string, options: RequestOptions & { query?: object; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json", ...options.headers };
    // Fastify rejects an empty body with a JSON content-type, so only set it when there is a body
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (method === "POST") headers["Idempotency-Key"] = options.idempotencyKey ?? crypto.randomUUID();

    const maxRetries = options.maxRetries ?? this.maxRetries;
    for (let attempt = 0; ; attempt++) {
      const signals = [AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs), ...(options.signal ? [options.signal] : [])];
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.any(signals),
        });
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (attempt < maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new ConnectionError(`${method} ${path} failed: ${(err as Error).message}`, { cause: err });
      }

      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await res.body?.cancel();
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        await sleep(retryAfter !== null ? Math.min(retryAfter, MAX_RETRY_DELAY_SEC) * 1000 : backoff(attempt));
        continue;
      }

      const text = await res.text();
      const isJson = (res.headers.get("content-type") ?? "").includes("json");
      let body: unknown = text;
      if (isJson && text) {
        try {
          body = JSON.parse(text);
        } catch {
          // leave as text
        }
      }
      if (!res.ok) throw errorFromResponse(res.status, res.headers, body);
      return body as T;
    }
  }

  protected async *paginate<T>(fetchPage: (cursor?: string) => Promise<Page<T>>): AsyncGenerator<T> {
    let cursor: string | undefined;
    do {
      const page = await fetchPage(cursor);
      yield* page.data;
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
  }
}

/** Exponential backoff with jitter: ~0.5s, 1s, 2s … capped at 8s. */
function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
