import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetHttpRetryForTests, setHttpRetryClockForTests } from "../http-retry.server";
import { fetchAllEvents, fetchCalendar, fetchEvent } from "../luma.server";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  let now = 0;
  setHttpRetryClockForTests({
    sleep: async (ms) => {
      now += ms;
    },
    random: () => 0,
    now: () => now,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetHttpRetryForTests();
});

describe("current Luma API", () => {
  test("uses the current calendar endpoint and root response", async () => {
    let requested = "";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requested = String(input);
      return Response.json({
        id: "cal-current",
        name: "Current calendar",
        slug: "current",
        avatar_url: null,
        cover_image_url: null,
        social_image_url: "https://images.luma.com/current.png",
        url: "https://luma.com/current",
      });
    }) as typeof fetch;

    const calendar = await fetchCalendar("secret-key");

    expect(requested).toBe("https://public-api.luma.com/v1/calendars/get");
    expect(calendar).toMatchObject({
      id: "cal-current",
      name: "Current calendar",
      cover_image_url: "https://images.luma.com/current.png",
    });
  });

  test("normalizes direct event entries and paginates managed plus listed events", async () => {
    const requested: URL[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      requested.push(url);
      const cursor = url.searchParams.get("pagination_cursor");
      return Response.json({
        entries: [
          {
            id: cursor ? "evt-2" : "evt-1",
            platform: "luma",
            access: cursor ? "view" : "manage",
            calendar_id: cursor ? "cal-origin" : "cal-current",
            name: cursor ? "Listed event" : "Managed event",
            cover_url: null,
            url: `https://luma.com/${cursor ? "listed" : "managed"}`,
            start_at: cursor ? "2026-08-02T10:00:00Z" : "2026-08-01T10:00:00Z",
            geo_address_json: { city: "Lima", region: "Lima" },
          },
        ],
        has_more: !cursor,
        next_cursor: cursor ? null : "page-2",
      });
    }) as typeof fetch;

    const snapshot = await fetchAllEvents("secret-key");
    const { events } = snapshot;

    expect(events.map((event) => event.api_id)).toEqual(["evt-1", "evt-2"]);
    expect(events[1]).toMatchObject({
      access: "view",
      calendar_id: "cal-origin",
      geo_address_info: { city_state: "Lima, Lima" },
    });
    expect(snapshot).toMatchObject({ complete: true, pages: 2 });
    expect(requested[0]?.pathname).toBe("/v1/calendars/events/list");
    expect(requested[0]?.searchParams.getAll("access")).toEqual(["manage", "view"]);
    expect(requested[1]?.searchParams.get("pagination_cursor")).toBe("page-2");
  });

  test("adds the maintenance lower bound and uses the current event lookup parameter", async () => {
    const requested: URL[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      requested.push(url);
      return Response.json(
        url.pathname.endsWith("/events/get")
          ? {
              id: "evt-one",
              name: "One",
              cover_url: null,
              url: "https://luma.com/one",
              start_at: "2026-08-01T10:00:00Z",
            }
          : { entries: [], has_more: false },
      );
    }) as typeof fetch;

    await fetchAllEvents("secret-key", {
      kind: "maintenance",
      after: "2026-07-21T00:00:00.000Z",
    });
    await fetchEvent("secret-key", "evt-one");

    expect(requested[0]?.searchParams.get("after")).toBe("2026-07-21T00:00:00.000Z");
    expect(requested[1]?.pathname).toBe("/v1/events/get");
    expect(requested[1]?.searchParams.get("event_id")).toBe("evt-one");
  });
});
