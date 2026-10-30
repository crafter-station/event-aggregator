import { afterEach, describe, expect, test } from "bun:test";
import {
  RateLimitedError,
  fetchWithRetry,
  getHostCooldownUntil,
  hostInFlightForTests,
  isHostCoolingDown,
  jitteredBackoffMs,
  parseRetryAfter,
  resetHttpRetryForTests,
  setHttpRetryClockForTests,
} from "../http-retry.server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetHttpRetryForTests();
});

describe("parseRetryAfter", () => {
  test("honours Retry-After seconds and caps the delay", () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    expect(parseRetryAfter("2", now, 30_000)).toBe(2000);
    expect(parseRetryAfter("120", now, 30_000)).toBe(30_000);
  });

  test("honours Retry-After HTTP-date", () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    expect(parseRetryAfter("Fri, 30 Oct 2026 12:00:08 GMT", now, 30_000)).toBe(8000);
  });
});

describe("jitteredBackoffMs", () => {
  test("grows and stays within the jittered bounds", () => {
    expect(jitteredBackoffMs(0, () => 0.5)).toBe(500);
    expect(jitteredBackoffMs(1, () => 0.5)).toBe(1000);
    expect(jitteredBackoffMs(2, () => 1)).toBe(4000);
    expect(jitteredBackoffMs(10, () => 1)).toBe(30_000);
    expect(jitteredBackoffMs(1, () => 0)).toBe(0);
  });
});

describe("fetchWithRetry", () => {
  test("retries a 429 using Retry-After seconds then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "3" } });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    const response = await fetchWithRetry("https://example.com/items", undefined, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      now: () => 1_000,
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([3000]);
  });

  test("exhausted 429 retries become RateLimitedError", async () => {
    globalThis.fetch = (async () =>
      new Response("no", { status: 429, headers: { "retry-after": "1" } })) as typeof fetch;

    let thrown: unknown;
    try {
      await fetchWithRetry("https://example.com/items", undefined, {
        maxRetries: 2,
        sleep: async () => {},
        random: () => 0,
        now: () => 0,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect(thrown).toMatchObject({ status: 429, host: "example.com", retryAfterMs: 1000 });
  });

  test("does not retry a 4xx other than 429", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const response = await fetchWithRetry("https://example.com/items", undefined, {
      sleep: async () => {
        throw new Error("should not sleep");
      },
    });
    expect(response.status).toBe(404);
    expect(calls).toBe(1);
  });

  test("the deadline aborts before another retry", async () => {
    let now = 0;
    globalThis.fetch = (async () => new Response("wait", { status: 503 })) as typeof fetch;

    await expect(
      fetchWithRetry("https://example.com/items", undefined, {
        maxRetries: 4,
        deadlineMs: 50,
        random: () => 1,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow(/deadline/i);
  });
});

describe("per-host throttle", () => {
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > 1000) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("caps concurrency at 2, spaces starts by 400ms, and cools down after 429", async () => {
    let now = 10_000;
    const held: Array<() => void> = [];
    const starts: number[] = [];

    globalThis.fetch = (async (input) => {
      starts.push(now);
      if (String(input).includes("cool")) {
        return new Response("no", { status: 429, headers: { "retry-after": "5" } });
      }
      await new Promise<void>((resolve) => {
        held.push(resolve);
      });
      return Response.json({ ok: true });
    }) as typeof fetch;

    setHttpRetryClockForTests({
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        now += ms;
      },
    });

    const first = fetchWithRetry("https://api.lu.ma/a");
    await waitFor(() => held.length === 1, "first in flight");
    const second = fetchWithRetry("https://api.lu.ma/b");
    await waitFor(() => held.length === 2, "second in flight");
    expect(hostInFlightForTests("api.lu.ma")).toBe(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(400);

    let thirdStarted = false;
    const third = fetchWithRetry("https://api.lu.ma/c").then((res) => {
      thirdStarted = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdStarted).toBe(false);
    expect(held.length).toBe(2);

    held[0]?.();
    await first;
    await waitFor(() => held.length === 3, "third in flight");
    held[1]?.();
    held[2]?.();
    await second;
    await third;
    expect(starts).toHaveLength(3);

    await expect(
      fetchWithRetry("https://api.lu.ma/cool", undefined, { maxRetries: 0 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(isHostCoolingDown("api.lu.ma", now)).toBe(true);
    expect(getHostCooldownUntil("api.lu.ma")).toBeGreaterThan(now);
  });
});
