import { describe, expect, test } from "bun:test";
import {
  normalizeSourceUrl,
  parseBulkSources,
  parseBulkSourcesReport,
} from "../owner-curated-catalog";
import { summarizeCalendarLibrary } from "../event-library-stats.functions";
import { maintenanceAfter, resolveSyncScope } from "../calendar-sync.server";
import {
  filterRunnableJobs,
  rateLimitedJobPlan,
  selectLumaSyncPath,
  shouldEnqueueCatalogRefresh,
} from "../calendar-sync-policy";

describe("calendar sync inputs", () => {
  test("parses named lines, raw URLs, and markdown table rows", () => {
    const sources = parseBulkSources(`
Hack0 Community — https://luma.com/hack0?k=c
https://luma.com/user/theveller
| AI First Founders | https://luma.com/ai-first-founders?k=c | Found |
`);
    expect(sources).toHaveLength(3);
    expect(sources[0]).toMatchObject({ name: "Hack0 Community", kind: "calendar" });
    expect(sources[1]).toMatchObject({ kind: "profile" });
    expect(sources[2].name).toBe("AI First Founders");
  });

  test("normalizes management links and tracking parameters", () => {
    expect(normalizeSourceUrl("https://luma.com/calendar/manage/cal-abc123?k=c")).toBe(
      "https://luma.com/calendar/cal-abc123",
    );
    expect(
      normalizeSourceUrl(
        "https://www.meetup.com/ProductTank-Lima?recSource=chapter-search&eventOrigin=find_page",
      ),
    ).toBe("https://www.meetup.com/producttank-lima");
  });

  test("parses multiline scraper CSV and deduplicates Meetup groups", () => {
    const sources = parseBulkSources(`"flex href","ds2-r12","ds2-m18","ds2-r13"
"https://www.meetup.com/AWSPERU?tracking=1","Lima","AWS User Group Peru","Line one
Line two"
"https://www.meetup.com/awsperu","Lima","Duplicate",""
"https://www.meetup.com/coders/events/309123456/","Lima","Single event",""
`);

    expect(sources).toEqual([
      {
        name: "AWS User Group Peru",
        url: "https://www.meetup.com/awsperu",
        kind: "group",
        provider: "meetup",
      },
    ]);
  });

  test("keeps the first row of headerless CSV", () => {
    expect(
      parseBulkSources(
        "AWS User Group Peru,https://www.meetup.com/awsperu\nProductTank Lima,https://www.meetup.com/producttank-lima",
      ).map(({ name, url }) => ({ name, url })),
    ).toEqual([
      { name: "AWS User Group Peru", url: "https://www.meetup.com/awsperu" },
      { name: "ProductTank Lima", url: "https://www.meetup.com/producttank-lima" },
    ]);
  });

  test("keeps every distinct Meetup group while collapsing tracking duplicates", () => {
    const rows = [
      '"flex href","name"',
      ...Array.from(
        { length: 79 },
        (_, index) =>
          `"https://www.meetup.com/group-${index + 1}?recSource=search","Group ${index + 1}"`,
      ),
      '"https://www.meetup.com/GROUP-1?eventOrigin=search","Duplicate Group 1"',
    ].join("\n");

    const sources = parseBulkSources(rows);
    expect(sources).toHaveLength(79);
    expect(sources.every((source) => source.provider === "meetup" && source.kind === "group")).toBe(
      true,
    );
  });

  test("runs one full import before switching to seven-day maintenance", () => {
    const now = Date.parse("2026-07-28T12:00:00.000Z");
    expect(resolveSyncScope(null, "auto", now)).toEqual({ kind: "full" });
    expect(resolveSyncScope("2026-07-20T00:00:00Z", "auto", now)).toEqual({
      kind: "maintenance",
      after: "2026-07-21T12:00:00.000Z",
    });
    expect(resolveSyncScope("2026-07-20T00:00:00Z", "full", now)).toEqual({
      kind: "full",
    });
    expect(maintenanceAfter(now)).toBe("2026-07-21T12:00:00.000Z");
  });
});

describe("bulk import accounting", () => {
  test("reports rows, duplicates and invalid lines", () => {
    const report = parseBulkSourcesReport(`
AWS User Group Peru — https://www.meetup.com/awsperu
Duplicate — https://www.meetup.com/AWSPERU?tracking=1
Not a source — https://example.com/foo
Hack0 — https://luma.com/hack0
`);
    expect(report.uniqueUrls).toBe(2);
    expect(report.duplicatesIgnored).toBe(1);
    expect(report.sources.map((s) => s.provider).sort()).toEqual(["luma", "meetup"]);
  });

  test("re-parsing the same CSV is idempotent", () => {
    const csv = "name,url\nA,https://www.meetup.com/a\nB,https://luma.com/b\n";
    expect(parseBulkSourcesReport(csv).sources).toEqual(parseBulkSourcesReport(csv).sources);
  });

  test("same slug on different providers stays separate", () => {
    const sources = parseBulkSources(
      "X — https://www.meetup.com/hack0\nY — https://luma.com/hack0",
    );
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((s) => s.provider)).size).toBe(2);
  });
});

describe("catalog re-enqueue guard", () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z");

  test("stops the cover re-enqueue loop after a completed sync", () => {
    expect(
      shouldEnqueueCatalogRefresh(
        {
          metadata_version: 1,
          calendar_avatar_url: "https://img/avatar.png",
          calendar_cover_url: null,
          imported_count: 12,
          last_sync_attempted_at: "2026-10-29T10:00:00.000Z",
          sync_status: "completed",
          source_metadata: { emptyConfirmed: false },
        },
        1,
        now,
      ),
    ).toBe(false);
  });

  test("does not enqueue initial when the source was attempted in the last 6 hours", () => {
    expect(
      shouldEnqueueCatalogRefresh(
        {
          metadata_version: 0,
          calendar_cover_url: null,
          imported_count: 0,
          last_sync_attempted_at: "2026-10-30T11:00:00.000Z",
          sync_status: "failed",
        },
        1,
        now,
      ),
    ).toBe(false);
  });
});

describe("luma job routing and rate limits", () => {
  test("a key row with null source_kind routes to the API path", () => {
    expect(selectLumaSyncPath({ source_kind: null, api_key_ciphertext: "ciphertext" })).toBe("api");
    expect(selectLumaSyncPath({ source_kind: "calendar", api_key_ciphertext: null })).toBe(
      "calendar",
    );
  });

  test("RateLimitedError requeues with a future scheduled_at and respects the attempt cap", () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    const retry = rateLimitedJobPlan(2, 5000, now, () => 0);
    expect(retry.status).toBe("queued");
    expect(Date.parse(retry.scheduledAt)).toBeGreaterThan(now);

    const failed = rateLimitedJobPlan(5, 1000, now, () => 0);
    expect(failed.status).toBe("failed");
  });

  test("one rate-limited Luma calendar does not stop a Meetup job in the same run", () => {
    const remaining = filterRunnableJobs(
      [
        { id: "luma-1", provider: "luma" },
        { id: "meetup-1", provider: "meetup" },
      ],
      true,
    );
    expect(remaining.map((job) => job.id)).toEqual(["meetup-1"]);
  });
});

describe("library summary", () => {
  test("counts providers, ownership, merged rows and errors from one list", () => {
    expect(
      summarizeCalendarLibrary([
        {
          provider: "luma",
          ownership: "connected",
          merged_into_id: null,
          sync_status: "completed",
        },
        { provider: "luma", ownership: "external", merged_into_id: null, sync_status: "failed" },
        { provider: "meetup", ownership: "external", merged_into_id: null, sync_status: "idle" },
        { provider: "luma", ownership: "connected", merged_into_id: "x", sync_status: "completed" },
      ]),
    ).toEqual({
      totalCalendars: 4,
      activeCalendars: 3,
      duplicateCalendars: 0,
      lumaConnected: 1,
      lumaExternal: 1,
      meetupExternal: 1,
      otherProviders: 0,
      mergedHidden: 1,
      erroredSources: 1,
      mineCalendars: 1,
    });
  });
});
