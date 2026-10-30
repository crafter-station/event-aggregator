// Public (unauthenticated) Luma calendar API. Lets us import a public calendar by
// URL with NO Luma API key and NO Firecrawl: the calendar page embeds a
// `calendar_api_id`, and api.lu.ma/calendar/get-items returns full event data.
// lu.ma now redirects to luma.com — both are handled.
//
// Server-only: external fetch, imported dynamically from server fns.
import { fetchWithRetry } from "./http-retry.server";

const LUMA_ORIGIN = "https://luma.com";
const LUMA_API = "https://api.lu.ma";

export type ResolvedCalendar = {
  apiId: string; // cal-...
  name: string;
  slug: string;
  url: string; // canonical luma.com/<slug>
  avatarUrl: string | null;
  coverUrl: string | null;
  description: string | null;
  tintColor: string | null;
  timezone: string | null;
  personalUserId: string | null;
  personalUsername: string | null;
};

export type PublicLumaEvent = {
  apiId: string; // evt-...
  slug: string; // public url slug
  name: string;
  coverUrl: string | null;
  startAt: string | null;
  endAt: string | null;
  city: string | null;
  hostIds: string[];
  hostNames: string[];
  /** Calendar that originally created the event. It may differ for aggregator calendars. */
  originCalendarApiId: string | null;
  url: string; // https://luma.com/<slug>
};

export type PublicCalendarEventSnapshot = {
  events: PublicLumaEvent[];
  pages: { future: number; past: number };
  entries: { future: number; past: number };
};

function normalize(input: string): { slug: string; url: string } {
  const u = new URL(input.trim());
  const manage = u.pathname.match(/^\/calendar\/manage\/(cal-[A-Za-z0-9]+)\/?$/i);
  const pathname = manage ? `/calendar/${manage[1]}` : u.pathname;
  const slug = pathname.replace(/^\/+|\/+$/g, "");
  return { slug, url: `${LUMA_ORIGIN}/${slug}` };
}

export async function getCalendarById(apiId: string): Promise<ResolvedCalendar | null> {
  const res = await fetchWithRetry(`${LUMA_API}/calendar/get?api_id=${encodeURIComponent(apiId)}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    calendar?: {
      api_id?: string;
      name?: string;
      slug?: string | null;
      avatar_url?: string | null;
      cover_image_url?: string | null;
      social_image_url?: string | null;
      description_short?: string | null;
      tint_color?: string | null;
      timezone?: string | null;
      personal_user_api_id?: string | null;
      personal_user?: {
        api_id?: string;
        name?: string;
        avatar_url?: string | null;
        timezone?: string | null;
        username?: string | null;
      } | null;
    };
  };
  const calendar = json.calendar;
  if (calendar?.api_id !== apiId) return null;
  const slug = calendar.slug ?? `calendar/${apiId}`;
  return {
    apiId,
    name: calendar.name?.trim() || apiId,
    slug,
    url: `${LUMA_ORIGIN}/${slug}`,
    avatarUrl: calendar.personal_user?.avatar_url ?? calendar.avatar_url ?? null,
    coverUrl: calendar.cover_image_url ?? calendar.social_image_url ?? null,
    description: calendar.description_short ?? null,
    tintColor: calendar.tint_color ?? null,
    timezone: calendar.personal_user?.timezone ?? calendar.timezone ?? null,
    personalUserId: calendar.personal_user?.api_id ?? calendar.personal_user_api_id ?? null,
    personalUsername: calendar.personal_user?.username ?? null,
  };
}

/** Resolve a public calendar URL to its api id + display name. */
export async function resolveLumaCalendar(input: string): Promise<ResolvedCalendar | null> {
  let slug: string;
  let url: string;
  try {
    ({ slug, url } = normalize(input));
  } catch {
    return null;
  }
  if (!slug) return null;
  const directId = slug.match(/(?:^|\/)(cal-[A-Za-z0-9]+)$/i)?.[1];
  if (directId) return getCalendarById(directId);

  const res = await fetchWithRetry(url, {
    headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const html = await res.text();

  const apiId = (html.match(/"api_id"\s*:\s*"(cal-[A-Za-z0-9]+)"/) || [])[1];
  if (!apiId) return null;

  const resolved = await getCalendarById(apiId);
  if (resolved) return resolved;
  return {
    apiId,
    name: slug,
    slug,
    url,
    avatarUrl: null,
    coverUrl: null,
    description: null,
    tintColor: null,
    timezone: null,
    personalUserId: null,
    personalUsername: null,
  };
}

type RawEvent = {
  api_id: string;
  calendar_api_id?: string;
  name: string;
  url?: string;
  cover_url?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  geo_address_info?: { city_state?: string | null } | null;
};

type RawEntry = {
  event?: RawEvent;
  hosts?: Array<{ api_id?: string; name?: string }>;
};

function toPublicEvent(entry: RawEntry): PublicLumaEvent {
  const ev = entry.event!;
  const slug = ev.url ?? ev.api_id;
  return {
    apiId: ev.api_id,
    slug,
    name: ev.name,
    coverUrl: ev.cover_url ?? null,
    startAt: ev.start_at ?? null,
    endAt: ev.end_at ?? null,
    city: ev.geo_address_info?.city_state ?? null,
    hostIds: (entry.hosts ?? []).flatMap((host) => (host.api_id ? [host.api_id] : [])),
    hostNames: (entry.hosts ?? []).flatMap((host) => (host.name ? [host.name] : [])),
    originCalendarApiId: ev.calendar_api_id ?? null,
    url: `${LUMA_ORIGIN}/${slug}`,
  };
}

async function fetchPage(
  calApiId: string,
  period: "future" | "past",
  cursor?: string,
): Promise<{ entries: RawEntry[]; hasMore: boolean; nextCursor?: string }> {
  const qs = new URLSearchParams({
    calendar_api_id: calApiId,
    period,
    pagination_limit: "50",
  });
  if (cursor) qs.set("pagination_cursor", cursor);
  const res = await fetchWithRetry(`${LUMA_API}/calendar/get-items?${qs.toString()}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Luma calendar events request failed (${res.status})`);
  }
  const json = (await res.json()) as {
    entries?: RawEntry[];
    has_more?: boolean;
    next_cursor?: string;
  };
  return {
    entries: json.entries ?? [],
    hasMore: Boolean(json.has_more),
    nextCursor: json.next_cursor,
  };
}

/** Fetch a public calendar's listed events (upcoming first, then past).
 *
 * Luma aggregator calendars legitimately list events created by other
 * calendars. The get-items endpoint is already scoped to `calApiId`, so
 * `event.calendar_api_id` is provenance, not a membership check.
 */
export async function fetchPublicCalendarEvents(
  calApiId: string,
  limit: number | null,
  scope: { kind: "full" } | { kind: "maintenance"; after: string } = { kind: "full" },
): Promise<PublicLumaEvent[]> {
  return (await fetchPublicCalendarEventSnapshot(calApiId, limit, scope)).events;
}

/** Fetch a complete, auditable snapshot of a public calendar.
 *
 * A feed is only considered complete after Luma returns `has_more=false`.
 * Repeated or missing cursors are treated as upstream failures instead of
 * silently accepting a truncated calendar.
 */
export type PublicEventsPage = {
  period: "future" | "past";
  cursor?: string;
  nextCursor?: string;
  pages: { future: number; past: number };
  events: PublicLumaEvent[];
};

export async function fetchPublicCalendarEventSnapshot(
  calApiId: string,
  limit: number | null,
  scope: { kind: "full" } | { kind: "maintenance"; after: string } = { kind: "full" },
  options?: {
    resume?: {
      period: "future" | "past";
      cursor?: string;
      pages?: { future: number; past: number };
    };
    onPage?: (page: PublicEventsPage) => Promise<void>;
  },
): Promise<PublicCalendarEventSnapshot> {
  const out: PublicLumaEvent[] = [];
  const seen = new Set<string>();
  const pages = {
    future: options?.resume?.pages?.future ?? 0,
    past: options?.resume?.pages?.past ?? 0,
  };
  const entriesSeen = { future: 0, past: 0 };
  const periods =
    options?.resume?.period === "past" ? (["past"] as const) : (["future", "past"] as const);

  for (const period of periods) {
    let cursor: string | undefined =
      options?.resume?.period === period ? options.resume.cursor : undefined;
    const cursors = new Set<string>();
    if (cursor) cursors.add(cursor);
    while (true) {
      const pageCursor = cursor;
      const { entries, hasMore, nextCursor } = await fetchPage(calApiId, period, cursor);
      pages[period]++;
      entriesSeen[period] += entries.length;
      const pageEvents: PublicLumaEvent[] = [];
      for (const e of entries) {
        const ev = e.event;
        if (!ev?.api_id) continue;
        if (
          period === "past" &&
          scope.kind === "maintenance" &&
          ev.start_at &&
          Date.parse(ev.start_at) < Date.parse(scope.after)
        ) {
          continue;
        }
        if (seen.has(ev.api_id)) continue;
        seen.add(ev.api_id);
        const mapped = toPublicEvent(e);
        pageEvents.push(mapped);
        out.push(mapped);
      }
      await options?.onPage?.({
        period,
        cursor: pageCursor,
        nextCursor,
        pages: { ...pages },
        events: pageEvents,
      });
      if (limit !== null && out.length >= limit) {
        return {
          events: out.slice(0, limit),
          pages,
          entries: entriesSeen,
        };
      }
      if (
        period === "past" &&
        scope.kind === "maintenance" &&
        entries.some(
          ({ event }) =>
            Boolean(event?.start_at) && Date.parse(event!.start_at!) < Date.parse(scope.after),
        )
      ) {
        break;
      }
      if (!hasMore) break;
      if (!nextCursor) {
        throw new Error(`Luma ${period} feed is incomplete: missing pagination cursor`);
      }
      if (cursors.has(nextCursor)) {
        throw new Error(`Luma ${period} feed is incomplete: repeated pagination cursor`);
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
  return {
    events: limit === null ? out : out.slice(0, limit),
    pages,
    entries: entriesSeen,
  };
}
