import { fail, loadCalendars } from "./supabase";

export type QueryStep = { method: string; args: unknown[] };

export function createRecordingClient(userId: string, rows: Record<string, unknown[]> = {}) {
  const steps: QueryStep[] = [];
  const makeQuery = (table: string) => {
    const query = {
      _table: table,
      select(...args: unknown[]) {
        steps.push({ method: "select", args: [table, ...args] });
        return query;
      },
      eq(...args: unknown[]) {
        steps.push({ method: "eq", args: [table, ...args] });
        return query;
      },
      in(...args: unknown[]) {
        steps.push({ method: "in", args: [table, ...args] });
        return query;
      },
      is(...args: unknown[]) {
        steps.push({ method: "is", args: [table, ...args] });
        return query;
      },
      or(...args: unknown[]) {
        steps.push({ method: "or", args: [table, ...args] });
        return query;
      },
      gte(...args: unknown[]) {
        steps.push({ method: "gte", args: [table, ...args] });
        return query;
      },
      lt(...args: unknown[]) {
        steps.push({ method: "lt", args: [table, ...args] });
        return query;
      },
      ilike(...args: unknown[]) {
        steps.push({ method: "ilike", args: [table, ...args] });
        return query;
      },
      order(...args: unknown[]) {
        steps.push({ method: "order", args: [table, ...args] });
        return query;
      },
      range(...args: unknown[]) {
        steps.push({ method: "range", args: [table, ...args] });
        return query;
      },
      limit(...args: unknown[]) {
        steps.push({ method: "limit", args: [table, ...args] });
        return query;
      },
      maybeSingle() {
        steps.push({ method: "maybeSingle", args: [table] });
        return Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null });
      },
      then(
        resolve: (value: { data: unknown[]; error: null; count: number }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve({
          data: rows[table] ?? [],
          error: null,
          count: (rows[table] ?? []).length,
        }).then(resolve, reject);
      },
    };
    return query.eq("user_id", userId);
  };
  return {
    userId,
    steps,
    from(table: string) {
      return makeQuery(table);
    },
  };
}

export function tokenQueryHasUserFilter(steps: QueryStep[], userId: string): boolean {
  const tables = new Set(
    steps
      .filter((step) => step.method === "select" || step.method === "eq")
      .map((step) => String(step.args[0])),
  );
  if (tables.size === 0) return false;
  for (const table of tables) {
    const hasUser = steps.some(
      (step) =>
        step.method === "eq" &&
        step.args[0] === table &&
        step.args[1] === "user_id" &&
        step.args[2] === userId,
    );
    if (!hasUser) return false;
    if (table === "canonical_events") {
      const hasEmbedded = steps.some(
        (step) =>
          step.method === "eq" &&
          step.args[1] === "event_sources.user_id" &&
          step.args[2] === userId,
      );
      const usedSources = steps.some(
        (step) => step.method === "select" && String(step.args[1] ?? "").includes("event_sources"),
      );
      if (usedSources && !hasEmbedded) return false;
    }
  }
  return true;
}

export async function loadCalendarsForToken(
  userId: string,
  client?: ReturnType<typeof createRecordingClient>,
) {
  const sb = client ?? (await tokenSupabase(userId));
  return loadCalendars(sb as unknown as Parameters<typeof loadCalendars>[0]);
}

async function tokenSupabase(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return {
    from(table: string) {
      return new TokenScopedQuery(
        supabaseAdmin.from(table as never) as unknown as LooseQuery,
        userId,
        table,
      );
    },
  };
}

type LooseQuery = {
  [key: string]: (...args: unknown[]) => unknown;
};

class TokenScopedQuery {
  constructor(
    private query: LooseQuery,
    private userId: string,
    private table: string,
    private filtered = false,
  ) {}

  private wrap(next: unknown): TokenScopedQuery {
    return new TokenScopedQuery(next as LooseQuery, this.userId, this.table, this.filtered);
  }

  private withUserFilter(): TokenScopedQuery {
    if (this.filtered) return this;
    const next = this.query.eq("user_id", this.userId);
    return new TokenScopedQuery(next as LooseQuery, this.userId, this.table, true);
  }

  select(...args: unknown[]) {
    return this.wrap(this.query.select(...args)).withUserFilter();
  }

  eq(...args: unknown[]) {
    return this.wrap(this.query.eq(...args));
  }

  in(...args: unknown[]) {
    return this.wrap(this.query.in(...args));
  }

  is(...args: unknown[]) {
    return this.wrap(this.query.is(...args));
  }

  or(...args: unknown[]) {
    return this.wrap(this.query.or(...args));
  }

  gte(...args: unknown[]) {
    return this.wrap(this.query.gte(...args));
  }

  lt(...args: unknown[]) {
    return this.wrap(this.query.lt(...args));
  }

  ilike(...args: unknown[]) {
    return this.wrap(this.query.ilike(...args));
  }

  order(...args: unknown[]) {
    return this.wrap(this.query.order(...args));
  }

  range(...args: unknown[]) {
    return this.wrap(this.query.range(...args));
  }

  limit(...args: unknown[]) {
    return this.wrap(this.query.limit(...args));
  }

  maybeSingle() {
    return this.withUserFilter().query.maybeSingle();
  }

  then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve(this.withUserFilter().query).then(resolve, reject);
  }
}

const EVENT_COLUMNS =
  "id, name, url, cover_url, start_at, end_at, city, country_code, timezone, is_online, tags";

export async function listEventsForToken(
  userId: string,
  input: {
    mine?: boolean;
    calendar_id?: string;
    status?: "all" | "upcoming" | "past";
    q?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  },
  client?: ReturnType<typeof createRecordingClient>,
) {
  const sb = client ?? (await tokenSupabase(userId));
  const pageSize = input.limit ?? 25;
  const offset = input.cursor ? Number(input.cursor) : 0;
  const now = new Date().toISOString();
  let rowIds: string[] | null = null;
  if (input.mine !== undefined || input.calendar_id) {
    const cals = await loadCalendars(sb as unknown as Parameters<typeof loadCalendars>[0]);
    if (!cals.ok) return fail("Could not load calendars");
    rowIds = cals.rows
      .filter((c) => !input.calendar_id || c.calendar_id === input.calendar_id)
      .filter((c) => input.mine === undefined || c.is_mine === input.mine)
      .map((c) => c.id);
    if (rowIds.length === 0) {
      return {
        content: [{ type: "text" as const, text: "[]" }],
        structuredContent: { events: [], nextCursor: null },
      };
    }
  }

  let query = rowIds
    ? sb
        .from("canonical_events")
        .select(`${EVENT_COLUMNS}, event_sources!inner(calendar_row_id)`, {
          count: "exact",
        } as never)
        .eq("event_sources.user_id" as never, userId as never)
        .in("event_sources.calendar_row_id" as never, rowIds as never)
    : sb.from("canonical_events").select(EVENT_COLUMNS, { count: "exact" } as never);
  if (input.status === "upcoming")
    query = query.or(`start_at.gte.${now},end_at.gte.${now}` as never);
  if (input.status === "past")
    query = query
      .lt("start_at" as never, now as never)
      .or(`end_at.is.null,end_at.lt.${now}` as never);
  if (input.from) query = query.gte("start_at" as never, input.from as never);
  if (input.to) query = query.lt("start_at" as never, input.to as never);
  if (input.q)
    query = query.ilike("name" as never, `%${input.q.replace(/[%_,()]/g, " ")}%` as never);
  query = query
    .order("start_at" as never, { ascending: input.status !== "past", nullsFirst: false } as never)
    .order("id" as never);
  const { data, error, count } = (await query.range(
    offset as never,
    (offset + pageSize - 1) as never,
  )) as {
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
    count: number | null;
  };
  if (error) {
    console.error("list_events", error);
    return fail("Could not load events");
  }
  const seen = new Set<string>();
  const events = (data ?? [])
    .filter((e) => typeof e.id === "string" && !seen.has(e.id) && seen.add(e.id))
    .map((e) => ({
      id: e.id,
      name: e.name,
      url: e.url,
      coverUrl: e.cover_url,
      startAt: e.start_at,
      endAt: e.end_at,
      city: e.city,
      countryCode: e.country_code,
      timezone: e.timezone,
      isOnline: e.is_online,
      tags: (e.tags as string[] | null) ?? [],
    }));
  const next = offset + (data?.length ?? 0);
  const nextCursor = count !== null && next < count ? String(next) : null;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ events, nextCursor, total: count }, null, 2),
      },
    ],
    structuredContent: { events, nextCursor, total: count ?? null },
  };
}

export async function getEventForToken(
  userId: string,
  id: string,
  client?: ReturnType<typeof createRecordingClient>,
) {
  const sb = client ?? (await tokenSupabase(userId));
  const { data: e, error } = (await sb
    .from("canonical_events")
    .select(
      "id, name, url, cover_url, description, start_at, end_at, timezone, city, country_code, region, venue_name, venue_address, is_online, language_code, host_name, event_format, tags, topics, audience, event_sources(provider, source_type, source_url, calendar_name, calendar_public_id, last_synced_at)",
    )
    .eq("event_sources.user_id" as never, userId as never)
    .eq("id" as never, id as never)
    .maybeSingle()) as {
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  };
  if (error) {
    console.error("get_event", error);
    return fail("Could not load event");
  }
  if (!e) return fail("Event not found");
  const sources = (e.event_sources as Array<Record<string, unknown>> | null) ?? [];
  const event = {
    id: e.id,
    name: e.name,
    url: e.url,
    coverUrl: e.cover_url,
    description: e.description,
    startAt: e.start_at,
    endAt: e.end_at,
    timezone: e.timezone,
    city: e.city,
    countryCode: e.country_code,
    region: e.region,
    venueName: e.venue_name,
    venueAddress: e.venue_address,
    isOnline: e.is_online,
    language: e.language_code,
    host: e.host_name,
    format: e.event_format,
    tags: (e.tags as string[] | null) ?? [],
    topics: (e.topics as string[] | null) ?? [],
    audience: (e.audience as string[] | null) ?? [],
    sources: sources.map((s) => ({
      provider: s.provider,
      sourceType: s.source_type,
      url: s.source_url,
      calendarName: s.calendar_name,
      calendarId: s.calendar_public_id,
      lastSyncedAt: s.last_synced_at,
    })),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(event, null, 2) }],
    structuredContent: { event },
  };
}
