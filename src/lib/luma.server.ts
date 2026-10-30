// Server-only Luma API helpers. Never import from client bundles.
// Auth: https://docs.lu.ma/reference/getting-started-with-your-api
import { fetchWithRetry } from "./http-retry.server";

export type LumaEvent = {
  api_id: string;
  platform?: "luma" | "external";
  access?: "manage" | "view";
  calendar_id?: string;
  name: string;
  cover_url: string | null;
  url: string;
  start_at: string;
  end_at?: string;
  description_md?: string;
  geo_address_info?: { city_state?: string; full_address?: string } | null;
  timezone?: string;
};

export type LumaListResponse = {
  entries: Array<{ event: LumaEvent; tags?: unknown[] }>;
  has_more: boolean;
  next_cursor?: string | null;
};

export type LumaCalendar = {
  id: string;
  name: string;
  slug: string | null;
  avatar_url: string | null;
  cover_image_url: string | null;
  url: string | null;
};

const LUMA_BASE = "https://public-api.luma.com/v1";

async function lumaFetch<T>(
  apiKey: string,
  path: string,
  params?: URLSearchParams | Record<string, string>,
): Promise<T> {
  const url = new URL(LUMA_BASE + path);
  if (params instanceof URLSearchParams) {
    for (const [key, value] of params) url.searchParams.append(key, value);
  } else if (params) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  }
  const res = await fetchWithRetry(url.toString(), {
    headers: {
      accept: "application/json",
      "x-luma-api-key": apiKey,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Luma ${path} failed [${res.status}]: ${body}`);
  }
  return (await res.json()) as T;
}

export async function fetchCalendar(apiKey: string): Promise<LumaCalendar> {
  const data = await lumaFetch<
    | {
        id: string;
        name: string;
        slug: string | null;
        avatar_url: string | null;
        cover_image_url: string | null;
        social_image_url: string | null;
        url: string | null;
      }
    | {
        calendar: {
          id: string;
          name: string;
          slug: string | null;
          avatar_url: string | null;
          cover_image_url: string | null;
          social_image_url: string | null;
          url: string | null;
        };
      }
  >(apiKey, "/calendars/get");
  const c = "calendar" in data ? data.calendar : data;
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    avatar_url: c.avatar_url,
    cover_image_url: c.cover_image_url ?? c.social_image_url ?? null,
    url: c.url,
  };
}

type CurrentLumaEvent = {
  id: string;
  platform?: "luma" | "external";
  access?: "manage" | "view";
  calendar_id?: string;
  name: string;
  cover_url?: string | null;
  url: string;
  start_at: string;
  end_at?: string;
  description_md?: string;
  description?: string;
  geo_address_info?: { city_state?: string; full_address?: string } | null;
  geo_address_json?: {
    city?: string;
    region?: string;
    full_address?: string;
  } | null;
  timezone?: string;
};

function normalizeEvent(event: CurrentLumaEvent | LumaEvent): LumaEvent {
  if ("api_id" in event) return event;
  const city = [event.geo_address_json?.city, event.geo_address_json?.region]
    .filter(Boolean)
    .join(", ");
  return {
    api_id: event.id,
    platform: event.platform,
    access: event.access,
    calendar_id: event.calendar_id,
    name: event.name,
    cover_url: event.cover_url ?? null,
    url: event.url,
    start_at: event.start_at,
    end_at: event.end_at,
    description_md: event.description_md ?? event.description,
    geo_address_info: {
      city_state: city || event.geo_address_json?.full_address,
      full_address: event.geo_address_json?.full_address,
    },
    timezone: event.timezone,
  };
}

export type LumaEventSyncScope = { kind: "full" } | { kind: "maintenance"; after: string };

export type LumaEventsPage = {
  events: LumaEvent[];
  nextCursor: string | null;
  pages: number;
  complete: boolean;
};

export async function fetchAllEvents(
  apiKey: string,
  scope: LumaEventSyncScope = { kind: "full" },
  options?: {
    resumeCursor?: string;
    resumePages?: number;
    onPage?: (page: LumaEventsPage) => Promise<void>;
  },
): Promise<{ events: LumaEvent[]; complete: boolean; pages: number }> {
  const out: LumaEvent[] = [];
  let cursor: string | undefined = options?.resumeCursor;
  let complete = false;
  let pages = options?.resumePages ?? 0;
  const MAX_PAGES = 400;
  for (let i = pages; i < MAX_PAGES; i++) {
    pages = i + 1;
    const params = new URLSearchParams({
      pagination_limit: "100",
      sort_column: "start_at",
      sort_direction: "asc",
    });
    params.append("platforms", "luma");
    params.append("platforms", "external");
    params.append("access", "manage");
    params.append("access", "view");
    if (scope.kind === "maintenance") params.set("after", scope.after);
    if (cursor) params.set("pagination_cursor", cursor);
    const data = await lumaFetch<
      | { entries: Array<CurrentLumaEvent>; has_more: boolean; next_cursor?: string | null }
      | LumaListResponse
    >(apiKey, "/calendars/events/list", params);
    const pageEvents: LumaEvent[] = [];
    for (const entry of data.entries ?? []) {
      const event = "event" in entry ? entry.event : entry;
      pageEvents.push(normalizeEvent(event));
    }
    out.push(...pageEvents);
    const nextCursor = data.has_more && data.next_cursor ? data.next_cursor : null;
    complete = !nextCursor;
    await options?.onPage?.({
      events: pageEvents,
      nextCursor,
      pages,
      complete,
    });
    if (complete) break;
    cursor = nextCursor ?? undefined;
  }
  return {
    events: [...new Map(out.map((event) => [event.api_id, event])).values()],
    complete,
    pages,
  };
}

export async function fetchEvent(apiKey: string, eventId: string): Promise<LumaEvent> {
  const data = await lumaFetch<CurrentLumaEvent | { event: LumaEvent }>(apiKey, "/events/get", {
    event_id: eventId,
  });
  return normalizeEvent("event" in data ? data.event : data);
}
