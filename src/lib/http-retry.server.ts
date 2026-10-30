export const LUMA_PUBLIC_HOST = "api.lu.ma";
export const LUMA_API_HOST = "public-api.luma.com";

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const THROTTLED_HOSTS = new Set([LUMA_PUBLIC_HOST, LUMA_API_HOST]);
const MAX_CONCURRENT = 2;
const MIN_SPACING_MS = 400;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_MAX_DELAY_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;

export class RateLimitedError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;
  readonly host: string;

  constructor(opts: { host: string; status?: number; retryAfterMs?: number; message?: string }) {
    super(opts.message ?? `Rate limited by ${opts.host}`);
    this.name = "RateLimitedError";
    this.status = opts.status ?? 429;
    this.retryAfterMs = opts.retryAfterMs ?? 0;
    this.host = opts.host;
  }
}

export type RetryClock = {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
};

type HostState = {
  inFlight: number;
  lastStartedAt: number;
  cooldownUntil: number;
  waiters: Array<() => void>;
};

const hosts = new Map<string, HostState>();
let clockOverride: Partial<RetryClock> | null = null;

export function setHttpRetryClockForTests(clock: Partial<RetryClock> | null): void {
  clockOverride = clock;
}

export function resetHttpRetryForTests(): void {
  hosts.clear();
  clockOverride = null;
}

function clock(): RetryClock {
  return {
    sleep:
      clockOverride?.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))),
    random: clockOverride?.random ?? Math.random,
    now: clockOverride?.now ?? Date.now,
  };
}

function hostState(host: string): HostState {
  const existing = hosts.get(host);
  if (existing) return existing;
  const created: HostState = { inFlight: 0, lastStartedAt: 0, cooldownUntil: 0, waiters: [] };
  hosts.set(host, created);
  return created;
}

function wake(host: string): void {
  const state = hosts.get(host);
  if (!state) return;
  const next = state.waiters.shift();
  next?.();
}

export function isHostCoolingDown(host: string, now = clock().now()): boolean {
  return hostState(host).cooldownUntil > now;
}

export function getHostCooldownUntil(host: string): number {
  return hostState(host).cooldownUntil;
}

export function isLumaHostCoolingDown(now = clock().now()): boolean {
  return isHostCoolingDown(LUMA_PUBLIC_HOST, now) || isHostCoolingDown(LUMA_API_HOST, now);
}

export function noteHostRateLimit(host: string, retryAfterMs: number, now = clock().now()): void {
  const state = hostState(host);
  state.cooldownUntil = Math.max(state.cooldownUntil, now + Math.max(0, retryAfterMs));
}

export function parseRetryAfter(
  header: string | null,
  now: number,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return Math.min(maxDelayMs, Number(trimmed) * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.min(maxDelayMs, Math.max(0, dateMs - now));
}

export function jitteredBackoffMs(
  attempt: number,
  random: () => number,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  const exp = Math.min(maxDelayMs, BACKOFF_BASE_MS * 2 ** attempt);
  return random() * exp;
}

export type FetchWithRetryOpts = {
  maxRetries?: number;
  maxDelayMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  sleep?: RetryClock["sleep"];
  random?: RetryClock["random"];
  now?: RetryClock["now"];
  pages?: number;
};

function requestHost(url: string): string {
  return new URL(url).host;
}

function assertGet(init?: RequestInit): void {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    throw new Error("fetchWithRetry only supports GET");
  }
}

function logLine(
  event: "provider_retry" | "provider_giveup",
  fields: {
    host: string;
    status: number | null;
    attempt: number;
    retryAfterMs: number | null;
    pages?: number;
  },
): void {
  console.info(
    JSON.stringify({
      event,
      host: fields.host,
      sourceId: null,
      status: fields.status,
      attempt: fields.attempt,
      retryAfterMs: fields.retryAfterMs,
      pages: fields.pages ?? null,
    }),
  );
}

async function acquireHost(
  host: string,
  opts: { deadlineMs?: number; signal?: AbortSignal },
): Promise<void> {
  if (!THROTTLED_HOSTS.has(host)) return;
  const { sleep, now } = clock();
  const state = hostState(host);
  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Aborted");
    const t = now();
    if (opts.deadlineMs !== undefined && t >= opts.deadlineMs) {
      throw new RateLimitedError({
        host,
        retryAfterMs: Math.max(0, state.cooldownUntil - t),
        message: `Deadline reached while waiting for ${host}`,
      });
    }
    if (state.cooldownUntil > t) {
      const wait = state.cooldownUntil - t;
      if (opts.deadlineMs !== undefined && t + wait >= opts.deadlineMs) {
        throw new RateLimitedError({
          host,
          retryAfterMs: wait,
          message: `Host ${host} is in cooldown`,
        });
      }
      await sleep(wait);
      continue;
    }
    if (state.inFlight >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
      continue;
    }
    const spacing = MIN_SPACING_MS - (t - state.lastStartedAt);
    if (state.lastStartedAt > 0 && spacing > 0) {
      await sleep(spacing);
      continue;
    }
    state.inFlight += 1;
    state.lastStartedAt = now();
    return;
  }
}

function releaseHost(host: string): void {
  if (!THROTTLED_HOSTS.has(host)) return;
  const state = hostState(host);
  state.inFlight = Math.max(0, state.inFlight - 1);
  wake(host);
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts: FetchWithRetryOpts = {},
): Promise<Response> {
  assertGet(init);
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const { sleep, random, now } = {
    sleep: opts.sleep ?? clock().sleep,
    random: opts.random ?? clock().random,
    now: opts.now ?? clock().now,
  };
  const host = requestHost(url);
  let lastError: unknown;
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Aborted");
    if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
      throw lastError instanceof Error ? lastError : new Error("Retry deadline exceeded");
    }

    await acquireHost(host, { deadlineMs: opts.deadlineMs, signal: opts.signal });
    let response: Response | undefined;
    try {
      response = await fetch(url, { ...init, method: "GET", signal: opts.signal });
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (
        typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw error;
      }
    } finally {
      releaseHost(host);
    }

    if (response) {
      lastStatus = response.status;
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) return response;
      const retryAfterMs =
        parseRetryAfter(response.headers.get("retry-after"), now(), maxDelayMs) ??
        jitteredBackoffMs(attempt, random, maxDelayMs);
      if (response.status === 429) {
        noteHostRateLimit(host, retryAfterMs, now());
        lastError = new RateLimitedError({ host, status: 429, retryAfterMs });
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
      if (attempt >= maxRetries) {
        logLine("provider_giveup", {
          host,
          status: response.status,
          attempt,
          retryAfterMs,
          pages: opts.pages,
        });
        if (response.status === 429) throw lastError;
        return response;
      }
      logLine("provider_retry", {
        host,
        status: response.status,
        attempt,
        retryAfterMs,
        pages: opts.pages,
      });
      if (opts.deadlineMs !== undefined && now() + retryAfterMs >= opts.deadlineMs) {
        if (response.status === 429) throw lastError;
        throw new Error("Retry deadline exceeded");
      }
      await sleep(retryAfterMs);
      continue;
    }

    const retryAfterMs = jitteredBackoffMs(attempt, random, maxDelayMs);
    if (attempt >= maxRetries) {
      logLine("provider_giveup", {
        host,
        status: lastStatus,
        attempt,
        retryAfterMs,
        pages: opts.pages,
      });
      throw lastError instanceof Error ? lastError : new Error("Network request failed");
    }
    logLine("provider_retry", {
      host,
      status: lastStatus,
      attempt,
      retryAfterMs,
      pages: opts.pages,
    });
    if (opts.deadlineMs !== undefined && now() + retryAfterMs >= opts.deadlineMs) {
      throw lastError instanceof Error ? lastError : new Error("Retry deadline exceeded");
    }
    await sleep(retryAfterMs);
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("fetchWithRetry exhausted");
}

export function hostInFlightForTests(host: string): number {
  return hostState(host).inFlight;
}
