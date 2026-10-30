import {
  CURATED_OWNER_EMAIL,
  OWNER_CURATED_SOURCES,
  normalizeSourceUrl,
  sourceCalendarId,
  type CuratedSource,
} from "./owner-curated-catalog";
import type { EventEnrichment } from "./canonical-events";
import { summarizeEventCounts } from "./event-time";
import {
  rateLimitedJobPlan,
  rateLimitedSourceStatus,
  readFreshSyncResume,
  selectLumaSyncPath,
  shouldEnqueueCatalogRefresh,
  shouldSkipLumaDuringCooldown,
  type SyncResume,
} from "./calendar-sync-policy";
import { RateLimitedError, getHostCooldownUntil, isLumaHostCoolingDown } from "./http-retry.server";

export type SyncSourceRow = {
  id: string;
  user_id: string;
  calendar_id: string;
  calendar_name: string | null;
  curated_name: string | null;
  remote_name: string | null;
  calendar_url: string | null;
  source_kind: "api" | "calendar" | "profile" | "event" | null;
  api_key_ciphertext?: string | null;
  sync_status: string;
  sync_error: string | null;
  event_limit: number;
  discovered_count: number;
  imported_count: number;
  last_synced_at: string | null;
  last_sync_attempted_at: string | null;
  historical_sync_completed_at: string | null;
  last_sync_scope: "full" | "maintenance" | null;
  next_sync_at: string | null;
  source_metadata: Record<string, unknown> | null;
  calendar_avatar_url: string | null;
  calendar_cover_url: string | null;
  calendar_description: string | null;
  calendar_tint_color: string | null;
  metadata_version: number;
  group_id: string | null;
  sort_order: number;
  suggested_group_name: string | null;
  suggested_group_reason: string | null;
  luma_calendar_id: string | null;
  merged_into_id: string | null;
  source: "api" | "scrape";
  organization_manual: boolean;
  provider: "luma" | "eventbrite" | "meetup";
  provider_source_id: string | null;
  provider_connection_id: string | null;
  ownership: "connected" | "external";
  sync_all_events: boolean;
};

const SOURCE_COLUMNS =
  "id,user_id,calendar_id,calendar_name,curated_name,remote_name,calendar_url,source_kind,api_key_ciphertext,sync_status,sync_error,event_limit,discovered_count,imported_count,last_synced_at,last_sync_attempted_at,historical_sync_completed_at,last_sync_scope,next_sync_at,source_metadata,calendar_avatar_url,calendar_cover_url,calendar_description,calendar_tint_color,metadata_version,group_id,sort_order,suggested_group_name,suggested_group_reason,luma_calendar_id,merged_into_id,source,organization_manual,provider,provider_source_id,provider_connection_id,ownership,sync_all_events";

const CALENDAR_METADATA_VERSION = 1;
const MAINTENANCE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type RequestedSyncScope = "auto" | "full" | "maintenance";
export type ResolvedSyncScope = { kind: "full" } | { kind: "maintenance"; after: string };

export function maintenanceAfter(now = Date.now()): string {
  return new Date(now - MAINTENANCE_LOOKBACK_MS).toISOString();
}

export function resolveSyncScope(
  historicalSyncCompletedAt: string | null,
  requested: RequestedSyncScope,
  now = Date.now(),
): ResolvedSyncScope {
  if (requested === "full" || !historicalSyncCompletedAt) return { kind: "full" };
  return { kind: "maintenance", after: maintenanceAfter(now) };
}

async function persistSyncResume(source: SyncSourceRow, resume: SyncResume | null): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const next = { ...(source.source_metadata ?? {}) };
  if (resume) next.syncResume = resume;
  else delete next.syncResume;
  source.source_metadata = next;
  const { error } = await supabaseAdmin
    .from("user_luma_calendars" as never)
    .update({ source_metadata: next } as never)
    .eq("id", source.id);
  if (error) throw new Error(error.message);
}

function suggestedGroup(source: SyncSourceRow, description: string | null) {
  const text = `${source.curated_name ?? ""} ${source.calendar_name ?? ""} ${description ?? ""}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  const rules: Array<[string, RegExp, string]> = [
    ["Personal", /\b(personal|ignacio|profile)\b/, "Personal calendar or profile"],
    [
      "Education",
      /\b(university|universidad|utec|utp|unsa|udep|student|education|educacion|dsc)\b/,
      "Education or university community",
    ],
    [
      "Startups & Venture",
      /\b(startup|founder|venture|capital|endeavor|growth|emprende|30x)\b/,
      "Startup, founder, or investment focus",
    ],
    [
      "Regional Tech",
      /\b(latam|peru|lima|arequipa|aqp|mexico|mx|bilbao|suyo)\b/,
      "Regional technology ecosystem",
    ],
    [
      "AI & Dev Tools",
      /\b(ai|ia |cursor|claude|codex|openai|supabase|vercel|n8n|notion|clerk|prisma|devin|elevenlabs|data)\b/,
      "AI or developer-tool ecosystem",
    ],
  ];
  const match = rules.find(([, pattern]) => pattern.test(text));
  return match
    ? { name: match[0], reason: match[2] }
    : { name: "Communities", reason: "Community and meetup calendar" };
}

export async function ensureOwnerCuratedCatalog(userId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: user } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (user.user?.email?.toLowerCase() === CURATED_OWNER_EMAIL) {
    for (const [index, source] of OWNER_CURATED_SOURCES.entries()) {
      const row = await ensureCuratedSourceRow(userId, source, index);
      if (shouldEnqueueCatalogRefresh(row, CALENDAR_METADATA_VERSION)) {
        await enqueueSource(userId, row.id, "initial");
      }
    }
  }
  await enqueueMeetupBrandingBackfill(userId);
}

/** Requeue only Meetup rows whose branding is incomplete. Safe to call on
 * every settings/calendar read: the unique queue constraint makes it
 * idempotent and the normal provider sync persists the resolved URLs. */
export async function enqueueMeetupBrandingBackfill(userId: string): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_luma_calendars" as never)
    .select("id")
    .eq("user_id", userId)
    .eq("provider", "meetup")
    .is("merged_into_id", null)
    .or("calendar_avatar_url.is.null,calendar_cover_url.is.null");
  const rows = (data as Array<{ id: string }> | null) ?? [];
  for (const row of rows) await enqueueSource(userId, row.id, "manual");
  return rows.length;
}

async function ensureCuratedSourceRow(
  userId: string,
  source: CuratedSource,
  sortOrder: number,
): Promise<SyncSourceRow> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { lumaCalendarIdFromValues } = await import("./calendar-identity");
  const { providerSourceId } = await import("./event-providers");
  const { resolveProviderScopedCalendarRowId, registerLumaCalendarIdentity, addCalendarAliases } =
    await import("./calendar-identity.server");
  const calendarId = sourceCalendarId(source);
  const calendarUrl = normalizeSourceUrl(source.url);
  const identity =
    source.provider === "luma" ? lumaCalendarIdFromValues({ calendarId, url: calendarUrl }) : null;
  const meetupProviderId =
    source.provider === "meetup" ? providerSourceId("meetup", calendarUrl) : null;
  const providerId = meetupProviderId ?? identity;
  // Identity lookups are always scoped to the same provider: a Luma calendar
  // must never resolve onto a Meetup row (or the other way around).
  let existingId: string | null = null;
  if (providerId) {
    const { data: providerMatch } = await supabaseAdmin
      .from("user_luma_calendars" as never)
      .select("id")
      .eq("user_id", userId)
      .eq("provider", source.provider)
      .eq("provider_source_id", providerId)
      .is("merged_into_id", null)
      .maybeSingle();
    existingId = (providerMatch as { id?: string } | null)?.id ?? null;
  }
  if (!existingId) {
    for (const candidate of [identity, calendarId, calendarUrl]) {
      existingId = await resolveProviderScopedCalendarRowId(userId, candidate, source.provider);
      if (existingId) break;
    }
  }
  const sourceKind = source.kind === "group" ? "calendar" : source.kind;
  const syncAllEvents =
    source.provider === "meetup" || /luma\.com\/cursorcommunity(?:[/?#]|$)/i.test(source.url);
  const values = {
    user_id: userId,
    ...(existingId
      ? {}
      : {
          calendar_id: calendarId,
          calendar_name: source.name,
          calendar_url: calendarUrl,
          source: "scrape",
          source_kind: sourceKind,
        }),
    provider: source.provider,
    provider_source_id: providerId,
    ownership: "external",
    event_limit: syncAllEvents ? 2000 : source.kind === "profile" ? 500 : 80,
    sync_all_events: syncAllEvents,
    sync_enabled: true,
    ...(existingId
      ? {}
      : {
          is_default: false,
          sort_order: sortOrder,
          next_sync_at: new Date().toISOString(),
        }),
    updated_at: new Date().toISOString(),
  };
  const query = existingId
    ? supabaseAdmin
        .from("user_luma_calendars" as never)
        .update(values as never)
        .eq("id", existingId)
        .eq("user_id", userId)
    : supabaseAdmin
        .from("user_luma_calendars" as never)
        .upsert(values as never, { onConflict: "user_id,calendar_id" });
  const { data, error } = await query.select(SOURCE_COLUMNS).single();
  if (error) throw new Error(error.message);
  let row = data as unknown as SyncSourceRow;
  // Never overwrite a user's manually curated display name.
  if (!row.organization_manual && row.curated_name !== source.name) {
    const { data: named, error: nameError } = await supabaseAdmin
      .from("user_luma_calendars" as never)
      .update({ curated_name: source.name } as never)
      .eq("id", row.id)
      .select(SOURCE_COLUMNS)
      .single();
    if (nameError) throw new Error(nameError.message);
    row = named as unknown as SyncSourceRow;
  }
  if (identity) {
    const winnerId = await registerLumaCalendarIdentity(userId, row.id, identity);
    if (winnerId !== row.id) {
      const { data: winner, error: winnerError } = await supabaseAdmin
        .from("user_luma_calendars" as never)
        .select(SOURCE_COLUMNS)
        .eq("id", winnerId)
        .single();
      if (winnerError) throw new Error(winnerError.message);
      row = winner as unknown as SyncSourceRow;
    }
  }
  await addCalendarAliases(userId, row.id, [
    { value: calendarId, kind: "legacy_id" },
    { value: calendarUrl, kind: "url" },
    { value: identity, kind: "luma_id" },
  ]);
  return row;
}

export async function listSyncSourcesForUser(userId: string): Promise<SyncSourceRow[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("user_luma_calendars" as never)
    .select(SOURCE_COLUMNS)
    .eq("user_id", userId)
    .is("merged_into_id", null)
    .order("curated_name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as SyncSourceRow[] | null) ?? [];
}

export type CuratedImportResult = {
  imported: number;
  created: number;
  existing: number;
  failed: Array<{ url: string; error: string }>;
};

export async function upsertCuratedSources(
  userId: string,
  sources: CuratedSource[],
): Promise<CuratedImportResult> {
  const before = (await listSyncSourcesForUser(userId)).length;
  const failed: Array<{ url: string; error: string }> = [];
  let imported = 0;
  for (const [index, source] of sources.entries()) {
    try {
      const row = await ensureCuratedSourceRow(userId, source, index);
      await enqueueSource(userId, row.id, "manual");
      imported++;
    } catch (error) {
      failed.push({
        url: source.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const created = Math.max(0, (await listSyncSourcesForUser(userId)).length - before);
  return { imported, created, existing: Math.max(0, imported - created), failed };
}

export async function enqueueSource(
  userId: string,
  sourceId: string,
  trigger: "initial" | "manual" | "scheduled",
  batchId?: string,
  syncScope: RequestedSyncScope = "auto",
): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("event_sync_jobs" as never).insert({
    user_id: userId,
    source_id: sourceId,
    batch_id: batchId ?? crypto.randomUUID(),
    trigger,
    sync_scope: syncScope,
    status: "queued",
    scheduled_at: new Date().toISOString(),
  } as never);
  if (error?.code === "23505") return;
  if (error) throw new Error(error.message);
  await supabaseAdmin
    .from("user_luma_calendars" as never)
    .update({ sync_status: "queued", sync_error: null } as never)
    .eq("id", sourceId)
    .eq("user_id", userId);
}

export async function enqueueAllSources(
  userId: string,
  trigger: "manual" | "scheduled",
  syncScope: RequestedSyncScope = "auto",
): Promise<{ batchId: string; queued: number }> {
  const sources = await listSyncSourcesForUser(userId);
  const batchId = crypto.randomUUID();
  for (const source of sources) {
    await enqueueSource(userId, source.id, trigger, batchId, syncScope);
  }
  return { batchId, queued: sources.length };
}

async function upsertScrapedRows(
  userId: string,
  source: SyncSourceRow,
  rows: Array<Record<string, unknown>>,
  syncedAt = new Date().toISOString(),
) {
  if (rows.length === 0) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const values = rows.map((row) => ({
    ...row,
    user_id: userId,
    calendar_id: source.id,
    updated_at: syncedAt,
  }));
  const result = await supabaseAdmin
    .from("scraped_events" as never)
    .upsert(values as never, { onConflict: "user_id,calendar_id,event_key" });
  if (result.error) throw new Error(result.error.message);

  const { tryUpsertCanonicalEventSource } = await import("./canonical-events.server");
  for (let offset = 0; offset < rows.length; offset += 10) {
    await Promise.all(
      rows.slice(offset, offset + 10).map((row) => {
        const eventKey = String(row.event_key);
        const payload =
          row.payload && typeof row.payload === "object"
            ? (row.payload as Record<string, unknown>)
            : {};
        const venue =
          payload.venue && typeof payload.venue === "object"
            ? (payload.venue as Record<string, unknown>)
            : null;
        const extractedEnrichment =
          payload.enrichment && typeof payload.enrichment === "object"
            ? (payload.enrichment as EventEnrichment)
            : {};
        const externalEventId =
          typeof (row.payload as Record<string, unknown> | undefined)?.externalEventId === "string"
            ? String((row.payload as Record<string, unknown>).externalEventId)
            : eventKey;
        const sourceType =
          source.provider === "eventbrite"
            ? source.ownership === "connected"
              ? "eventbrite_api"
              : "eventbrite_public"
            : source.provider === "meetup"
              ? source.ownership === "connected"
                ? "meetup_api"
                : "meetup_public"
              : source.source_kind === "profile"
                ? "profile_scrape"
                : "calendar_scrape";
        return tryUpsertCanonicalEventSource(userId, {
          event: {
            id: eventKey,
            name: String(row.name),
            coverUrl: typeof row.cover_url === "string" ? row.cover_url : null,
            url: String(row.source_url),
            startAt: typeof row.start_at === "string" ? row.start_at : new Date().toISOString(),
            endAt: typeof row.end_at === "string" ? row.end_at : undefined,
            city: typeof row.city === "string" ? row.city : undefined,
            description: typeof row.description === "string" ? row.description : undefined,
            timezone: typeof payload.timezone === "string" ? payload.timezone : null,
            enrichment: {
              ...extractedEnrichment,
              venueName:
                typeof venue?.name === "string"
                  ? venue.name
                  : (extractedEnrichment.venueName ?? null),
              region:
                typeof venue?.state === "string"
                  ? venue.state
                  : typeof venue?.city === "string"
                    ? venue.city
                    : (extractedEnrichment.region ?? null),
              countryCode:
                typeof venue?.country === "string"
                  ? venue.country.toUpperCase()
                  : (extractedEnrichment.countryCode ?? null),
              isOnline:
                typeof venue?.name === "string"
                  ? /online|virtual/i.test(venue.name)
                  : (extractedEnrichment.isOnline ?? null),
              organizer: typeof row.host_name === "string" ? row.host_name : null,
              sources: {
                ...(extractedEnrichment.sources ?? {}),
                venue: venue ? "provider" : (extractedEnrichment.sources?.venueName ?? "unknown"),
                organizer: row.host_name ? "provider" : "unknown",
              },
            },
            calendarId: source.calendar_id,
            calendarName: source.curated_name ?? source.calendar_name ?? undefined,
          },
          sourceType,
          provider: source.provider,
          calendarRowId: source.id,
          calendarId: source.calendar_id,
          calendarName: source.curated_name ?? source.calendar_name,
          sourceUrl: String(row.source_url),
          externalEventId,
          hostName: typeof row.host_name === "string" ? row.host_name : null,
          payload,
          lastSyncedAt: syncedAt,
        });
      }),
    );
  }
}

async function countPersistedEventsForSource(
  userId: string,
  sourceId: string,
): Promise<number | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("event_sources" as never)
    .select("canonical_event_id")
    .eq("user_id", userId)
    .eq("calendar_row_id", sourceId);
  if (error) {
    if (/schema cache|does not exist/i.test(error.message)) return null;
    throw new Error(error.message);
  }
  return new Set(
    ((data as Array<{ canonical_event_id: string }> | null) ?? []).map(
      (row) => row.canonical_event_id,
    ),
  ).size;
}

async function finalizeScopedSync(
  userId: string,
  source: SyncSourceRow,
  runStartedAt: string,
  sourceTypes: string[],
  scope: ResolvedSyncScope,
  removeScrapedSources = false,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.rpc(
    "finalize_scoped_calendar_sync" as never,
    {
      p_user_id: userId,
      p_calendar_row_id: source.id,
      p_run_started_at: runStartedAt,
      p_source_types: sourceTypes,
      p_after: scope.kind === "maintenance" ? scope.after : null,
      p_remove_scraped_sources: removeScrapedSources,
    } as never,
  );
  if (error) throw new Error(error.message);
}

async function syncConnectedProvider(
  userId: string,
  source: SyncSourceRow,
  scope: ResolvedSyncScope,
) {
  if (source.provider === "luma" || !source.provider_connection_id) {
    throw new Error("Provider connection is unavailable");
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: connection, error } = await supabaseAdmin
    .from("provider_connections" as never)
    .select("access_token_ciphertext,refresh_token_ciphertext,token_expires_at")
    .eq("id", source.provider_connection_id)
    .eq("user_id", userId)
    .single();
  if (error || !connection) throw new Error(error?.message ?? "Provider connection not found");
  const { decryptString } = await import("./crypto.server");
  const stored = connection as {
    access_token_ciphertext: string;
    refresh_token_ciphertext: string | null;
    token_expires_at: string | null;
  };
  let token = decryptString(stored.access_token_ciphertext);
  const { fetchConnectedProviderSnapshot, refreshMeetupAccessToken } =
    await import("./event-providers.server");
  if (
    source.provider === "meetup" &&
    stored.refresh_token_ciphertext &&
    (!stored.token_expires_at || Date.parse(stored.token_expires_at) <= Date.now() + 60_000)
  ) {
    const refreshed = await refreshMeetupAccessToken(
      decryptString(stored.refresh_token_ciphertext),
    );
    const { encryptString } = await import("./crypto.server");
    token = refreshed.accessToken;
    const { error: refreshError } = await supabaseAdmin
      .from("provider_connections" as never)
      .update({
        access_token_ciphertext: encryptString(refreshed.accessToken),
        refresh_token_ciphertext: encryptString(refreshed.refreshToken),
        token_expires_at: refreshed.expiresAt,
      } as never)
      .eq("id", source.provider_connection_id)
      .eq("user_id", userId);
    if (refreshError) throw new Error(refreshError.message);
  }
  const runStartedAt = new Date().toISOString();
  const snapshot = await fetchConnectedProviderSnapshot(
    source.provider,
    source.calendar_url ?? "",
    token,
    scope.kind === "maintenance" || source.sync_all_events ? null : source.event_limit || 80,
    scope,
  );
  const snapshotComplete = snapshot.complete && snapshot.truncated !== true;
  const rows = snapshot.events.map(({ event, externalId, hostName, payload }) => ({
    event_key: `${source.provider}-${externalId}`,
    source_url: event.url,
    name: event.name,
    description: event.description ?? null,
    cover_url: event.coverUrl,
    city: event.city ?? null,
    start_at: event.startAt,
    end_at: event.endAt ?? null,
    host_name: hostName,
    payload: { ...payload, externalEventId: externalId, provider: source.provider },
  }));
  await upsertScrapedRows(userId, source, rows, runStartedAt);
  if (snapshotComplete) {
    const sourceTypes = source.provider === "eventbrite" ? ["eventbrite_api"] : ["meetup_api"];
    await finalizeScopedSync(userId, source, runStartedAt, sourceTypes, scope);
  }
  return {
    discovered: snapshot.discoveredCount ?? rows.length,
    imported: rows.length,
    remoteName: snapshot.name,
    avatarUrl: snapshot.avatarUrl,
    coverUrl: snapshot.coverUrl,
    description: snapshot.description,
    tintColor: null,
    metadata: {
      provider: source.provider,
      providerSourceId: source.provider_source_id,
      ingestion: `${source.provider}-api`,
      syncScope: scope.kind,
      authoritativeSnapshotAt: runStartedAt,
      emptyConfirmed: rows.length === 0,
      discoveredCount: snapshot.discoveredCount ?? rows.length,
      readableCount: snapshot.readableCount ?? rows.length,
      cancelledCount: snapshot.cancelledCount ?? 0,
      unreadableCount: snapshot.unreadableCount ?? 0,
      truncated: snapshot.truncated ?? false,
      imageSource: snapshot.imageSource ?? null,
      linkPreviewImageUrl: snapshot.previewImageUrl ?? null,
      linkPreviewLogoUrl: snapshot.logoUrl ?? null,
      nextEventAt:
        rows
          .map((row) => row.start_at)
          .filter((value) => Date.parse(value) >= Date.now())
          .sort()[0] ?? null,
    },
    partial: !snapshotComplete,
    warning: snapshot.warnings?.join(" · ") || null,
    historicalComplete: scope.kind === "full" && snapshotComplete,
  };
}

async function syncPublicProvider(userId: string, source: SyncSourceRow, scope: ResolvedSyncScope) {
  if (source.provider === "luma") throw new Error("Public provider source is invalid");
  const { fetchPublicProviderSnapshot } = await import("./event-providers.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const runStartedAt = new Date().toISOString();
  let skipUrls: string[] = [];
  if (scope.kind === "maintenance") {
    const { data: oldCached } = await supabaseAdmin
      .from("scraped_events" as never)
      .select("source_url")
      .eq("user_id", userId)
      .eq("calendar_id", source.id)
      .lt("start_at", scope.after);
    skipUrls = ((oldCached as Array<{ source_url: string }> | null) ?? []).map(
      ({ source_url }) => source_url,
    );
  }
  const snapshot = await fetchPublicProviderSnapshot(
    source.provider,
    source.calendar_url ?? "",
    source.sync_all_events ? null : source.event_limit || 80,
    {
      skipUrls,
      after: scope.kind === "maintenance" ? scope.after : undefined,
    },
  );
  const cachedLogo =
    typeof source.source_metadata?.linkPreviewLogoUrl === "string"
      ? source.source_metadata.linkPreviewLogoUrl
      : null;
  const cachedPreview =
    typeof source.source_metadata?.linkPreviewImageUrl === "string"
      ? source.source_metadata.linkPreviewImageUrl
      : null;
  const effectiveAvatar = snapshot.avatarUrl ?? cachedLogo ?? cachedPreview;
  const effectiveCover = snapshot.coverUrl ?? cachedPreview ?? cachedLogo;
  const snapshotComplete = snapshot.complete && snapshot.truncated !== true;
  const rows = snapshot.events.map(({ event, externalId, hostName, payload }) => ({
    event_key: `${source.provider}-${externalId}`,
    source_url: event.url,
    name: event.name,
    description: event.description ?? null,
    cover_url: event.coverUrl,
    city: event.city ?? null,
    start_at: event.startAt,
    end_at: event.endAt ?? null,
    host_name: hostName,
    payload: { ...payload, externalEventId: externalId, provider: source.provider },
  }));
  await upsertScrapedRows(userId, source, rows, runStartedAt);
  if (snapshotComplete) {
    await finalizeScopedSync(
      userId,
      source,
      runStartedAt,
      [source.provider === "eventbrite" ? "eventbrite_public" : "meetup_public"],
      scope,
    );
  }
  return {
    discovered: snapshot.discoveredCount ?? rows.length,
    imported: rows.length,
    remoteName: snapshot.name,
    avatarUrl: effectiveAvatar,
    coverUrl: effectiveCover,
    description: snapshot.description,
    tintColor: null,
    metadata: {
      provider: source.provider,
      providerSourceId: source.provider_source_id,
      ingestion: `${source.provider}-public`,
      syncScope: scope.kind,
      emptyConfirmed: rows.length === 0,
      discoveredCount: snapshot.discoveredCount ?? rows.length,
      readableCount: snapshot.readableCount ?? rows.length,
      cancelledCount: snapshot.cancelledCount ?? 0,
      unreadableCount: snapshot.unreadableCount ?? 0,
      truncated: snapshot.truncated ?? false,
      imageSource: snapshot.imageSource ?? null,
      linkPreviewImageUrl: snapshot.previewImageUrl ?? null,
      linkPreviewLogoUrl: snapshot.logoUrl ?? null,
      nextEventAt:
        rows
          .map((row) => row.start_at)
          .filter((value) => Date.parse(value) >= Date.now())
          .sort()[0] ?? null,
    },
    partial: !snapshotComplete,
    warning: snapshot.warnings?.join(" · ") || null,
    historicalComplete: scope.kind === "full" && snapshotComplete,
  };
}

async function syncApiCalendar(userId: string, source: SyncSourceRow, scope: ResolvedSyncScope) {
  const { resolveKeyForCalendar } = await import("./user-luma-calendars.functions");
  const resolved = await resolveKeyForCalendar(userId, source.calendar_id);
  if (!resolved?.key) throw new Error("Luma API key is unavailable for this calendar");
  const { fetchAllEvents, fetchCalendar } = await import("./luma.server");
  const runStartedAt = new Date().toISOString();
  const resume = readFreshSyncResume(source.source_metadata);
  let calendar: Awaited<ReturnType<typeof fetchCalendar>> | undefined;
  let events: Awaited<ReturnType<typeof import("./luma.server").fetchAllEvents>>["events"] = [];
  let apiComplete = false;
  let apiPages = 0;
  try {
    const [cal, snapshot] = await Promise.all([
      fetchCalendar(resolved.key),
      fetchAllEvents(resolved.key, scope, {
        resumeCursor: resume?.cursor ?? undefined,
        resumePages: typeof resume?.pages === "number" ? resume.pages : undefined,
        onPage: async (page) => {
          events.push(...page.events);
          const { upsertCanonicalEventSource } = await import("./canonical-events.server");
          for (let offset = 0; offset < page.events.length; offset += 10) {
            await Promise.all(
              page.events.slice(offset, offset + 10).map((event) =>
                upsertCanonicalEventSource(userId, {
                  event: {
                    id: event.api_id,
                    name: event.name,
                    coverUrl: event.cover_url,
                    url: event.url,
                    startAt: event.start_at,
                    endAt: event.end_at,
                    city: event.geo_address_info?.city_state,
                    description: event.description_md,
                    calendarId: source.calendar_id,
                    calendarName: calendar?.name ?? source.calendar_name ?? undefined,
                  },
                  sourceType: "api",
                  calendarRowId: source.id,
                  calendarId: source.calendar_id,
                  calendarName: calendar?.name ?? source.calendar_name ?? undefined,
                  sourceUrl: event.url,
                  externalEventId: event.api_id,
                  payload: {
                    source: "luma-api",
                    timezone: event.timezone ?? null,
                    access: event.access ?? "manage",
                    platform: event.platform ?? "luma",
                    originCalendarId: event.calendar_id ?? null,
                  },
                  lastSyncedAt: runStartedAt,
                }),
              ),
            );
          }
          await persistSyncResume(source, {
            scope: scope.kind,
            cursor: page.nextCursor,
            pages: page.pages,
            updatedAt: new Date().toISOString(),
          });
        },
      }),
    ]);
    calendar = cal;
    events = snapshot.events;
    apiComplete = snapshot.complete;
    apiPages = snapshot.pages;
  } catch (error) {
    if (error instanceof RateLimitedError) throw error;
    const apiError = error instanceof Error ? error.message : String(error);
    if (!source.calendar_url) throw error;
    try {
      const fallback = await syncCalendar(userId, source, scope);
      return {
        ...fallback,
        partial: true,
        warning: `Luma API unavailable; public link used instead. ${apiError}`,
        metadata: {
          ...fallback.metadata,
          ingestion: "luma-public-fallback",
          apiAuthStatus: /\[(401|403)\]/.test(apiError) ? "needs_attention" : "connected",
          apiError,
        },
      };
    } catch (fallbackError) {
      const linkError =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${apiError}; public link fallback failed: ${linkError}`);
    }
  }
  if (apiComplete) {
    await persistSyncResume(source, null);
    await finalizeScopedSync(userId, source, runStartedAt, ["api"], scope, true);
  }
  const upcoming = events
    .map((event) => event.start_at)
    .filter((value) => Date.parse(value) >= Date.now())
    .sort()[0];
  return {
    discovered: events.length,
    imported: events.length,
    remoteName: calendar.name,
    avatarUrl: calendar.avatar_url,
    coverUrl: calendar.cover_image_url,
    description: source.calendar_description,
    tintColor: source.calendar_tint_color,
    metadata: {
      lumaCalendarId: calendar.id,
      slug: calendar.slug,
      ingestion: "luma-api",
      syncScope: scope.kind,
      apiAuthStatus: "connected",
      authoritativeSnapshotAt: runStartedAt,
      emptyConfirmed: events.length === 0,
      nextEventAt: upcoming ?? null,
      pages: apiPages,
      paginationComplete: apiComplete,
    },
    partial: !apiComplete,
    warning: apiComplete ? null : "Luma API pagination truncated; not marking as complete",
    historicalComplete: scope.kind === "full" && apiComplete,
  };
}

async function resolveKnownLumaCalendar(userId: string, source: SyncSourceRow) {
  const { resolveLumaCalendar, getCalendarById } = await import("./luma-public.server");
  // 1. Known canonical id from a previous sync — survives Luma blocking the
  //    public HTML page, which is the usual cause of false "inaccessible".
  const knownIds = new Set<string>();
  if (source.luma_calendar_id) knownIds.add(source.luma_calendar_id);
  const metaId = source.source_metadata?.lumaCalendarId;
  if (typeof metaId === "string") knownIds.add(metaId);
  if (/^cal-[A-Za-z0-9]+$/i.test(source.calendar_id)) knownIds.add(source.calendar_id);
  // 2. Aliases recorded for this row.
  const { readCalendarAliases } = await import("./calendar-identity.server");
  const aliases = (await readCalendarAliases(userId, [source.id])).get(source.id) ?? [];
  for (const alias of aliases) {
    const match = alias.match(/(cal-[A-Za-z0-9]+)/i);
    if (match) knownIds.add(match[1]);
  }
  for (const apiId of knownIds) {
    const resolved = await getCalendarById(apiId);
    if (resolved) return resolved;
  }
  // 3. Fall back to resolving the public URL.
  return resolveLumaCalendar(source.calendar_url ?? "");
}

async function syncCalendar(userId: string, source: SyncSourceRow, scope: ResolvedSyncScope) {
  const { fetchPublicCalendarEventSnapshot } = await import("./luma-public.server");
  const calendar = await resolveKnownLumaCalendar(userId, source);
  if (!calendar) throw new Error("Calendar is not publicly accessible");
  const runStartedAt = new Date().toISOString();
  const resume = readFreshSyncResume(source.source_metadata);
  let eventSnapshot: Awaited<ReturnType<typeof fetchPublicCalendarEventSnapshot>> | null = null;
  let events: Awaited<ReturnType<typeof fetchPublicCalendarEventSnapshot>>["events"] = [];
  let publicError: string | null = null;
  try {
    eventSnapshot = await fetchPublicCalendarEventSnapshot(
      calendar.apiId,
      scope.kind === "maintenance" || source.sync_all_events ? null : source.event_limit || 80,
      scope,
      {
        resume:
          resume?.period === "future" || resume?.period === "past"
            ? {
                period: resume.period,
                cursor: resume.cursor ?? undefined,
                pages:
                  typeof resume.pages === "object"
                    ? resume.pages
                    : { future: 0, past: typeof resume.pages === "number" ? resume.pages : 0 },
              }
            : undefined,
        onPage: async (page) => {
          const rows = page.events.map((event) => ({
            event_key: event.apiId,
            source_url: event.url,
            name: event.name,
            description: null,
            cover_url: event.coverUrl,
            city: event.city,
            start_at: event.startAt,
            end_at: event.endAt,
            host_name: event.hostNames[0] ?? null,
            payload: {
              source: "luma-public-api",
              externalEventId: event.apiId,
              listedByCalendarId: calendar.apiId,
              originCalendarApiId: event.originCalendarApiId,
              hostIds: event.hostIds,
              hostNames: event.hostNames,
            },
          }));
          if (rows.length > 0) await upsertScrapedRows(userId, source, rows, runStartedAt);
          await persistSyncResume(source, {
            scope: scope.kind,
            period: page.period,
            cursor: page.nextCursor ?? null,
            pages: page.pages,
            updatedAt: new Date().toISOString(),
          });
        },
      },
    );
    events = eventSnapshot.events;
  } catch (error) {
    if (error instanceof RateLimitedError) throw error;
    publicError = error instanceof Error ? error.message : String(error);
  }
  const fallbackRows: Array<Record<string, unknown>> = [];
  let sourceBranding: Awaited<
    ReturnType<(typeof import("./firecrawl.server"))["firecrawlScrapeSource"]>
  > | null = null;
  if (events.length === 0) {
    const {
      firecrawlDiscoverLumaEvents,
      firecrawlScrapeEvent,
      firecrawlScrapeSource,
      hasFirecrawl,
    } = await import("./firecrawl.server");
    if (!hasFirecrawl() && publicError) throw new Error(publicError);
    const urls = await firecrawlDiscoverLumaEvents(
      source.calendar_url ?? calendar.url,
      source.event_limit || 80,
    );
    sourceBranding = await firecrawlScrapeSource(source.calendar_url ?? calendar.url);
    for (let offset = 0; offset < urls.length; offset += 5) {
      const scraped = await Promise.all(
        urls.slice(offset, offset + 5).map(async (eventUrl) => {
          const event = await firecrawlScrapeEvent(eventUrl);
          if (!event) return null;
          return {
            event_key: `scr-${stableHash(eventUrl)}`,
            source_url: eventUrl,
            name: event.name,
            description: event.description,
            cover_url: event.coverUrl,
            city: event.city,
            start_at: event.startAt,
            end_at: event.endAt,
            host_name: event.hostName,
            payload: {
              source: "calendar-firecrawl-fallback",
              externalEventId: null,
              branding: event.branding ?? null,
              enrichment: event.enrichment,
            },
          };
        }),
      );
      fallbackRows.push(...scraped.filter((row): row is NonNullable<typeof row> => row !== null));
    }
  }
  const rows =
    events.length > 0
      ? events.map((event) => ({
          event_key: event.apiId,
          source_url: event.url,
          name: event.name,
          description: null,
          cover_url: event.coverUrl,
          city: event.city,
          start_at: event.startAt,
          end_at: event.endAt,
          host_name: event.hostNames[0] ?? null,
          payload: {
            source: "luma-public-api",
            externalEventId: event.apiId,
            listedByCalendarId: calendar.apiId,
            originCalendarApiId: event.originCalendarApiId,
            hostIds: event.hostIds,
            hostNames: event.hostNames,
          },
        }))
      : fallbackRows;
  await upsertScrapedRows(userId, source, rows, runStartedAt);
  if (!publicError) {
    await persistSyncResume(source, null);
    await finalizeScopedSync(userId, source, runStartedAt, ["calendar_scrape"], scope);
  }
  const temporalCounts = summarizeEventCounts(
    rows.map((row) => ({
      startAt: typeof row.start_at === "string" ? row.start_at : "",
      endAt: typeof row.end_at === "string" ? row.end_at : null,
    })),
  );
  return {
    discovered: rows.length,
    imported: rows.length,
    remoteName: calendar.name,
    avatarUrl: calendar.avatarUrl ?? sourceBranding?.avatarUrl ?? sourceBranding?.coverUrl ?? null,
    coverUrl: calendar.coverUrl ?? sourceBranding?.coverUrl ?? null,
    description: calendar.description ?? sourceBranding?.description ?? null,
    tintColor: calendar.tintColor,
    metadata: {
      lumaCalendarId: calendar.apiId,
      slug: calendar.slug,
      timezone: calendar.timezone,
      personalUserId: calendar.personalUserId,
      personalUsername: calendar.personalUsername,
      ingestion: events.length > 0 ? "luma-public-api" : "firecrawl-fallback",
      syncScope: scope.kind,
      eventCounts: temporalCounts,
      pagination: eventSnapshot
        ? {
            futurePages: eventSnapshot.pages.future,
            pastPages: eventSnapshot.pages.past,
            futureEntries: eventSnapshot.entries.future,
            pastEntries: eventSnapshot.entries.past,
            exhausted: true,
          }
        : null,
      emptyConfirmed: rows.length === 0,
      publicError,
      nextEventAt:
        rows
          .map((row) => (typeof row.start_at === "string" ? row.start_at : null))
          .filter((value): value is string => Boolean(value))
          .filter((value) => Date.parse(value) >= Date.now())
          .sort()[0] ?? null,
    },
    partial: publicError !== null && rows.length > 0,
    warning: publicError,
    historicalComplete: scope.kind === "full" && publicError === null,
  };
}

async function profileHostedCount(url: string): Promise<number | null> {
  const response = await fetch(url, { headers: { accept: "text/html" } });
  if (!response.ok) return null;
  const html = await response.text();
  const count = html.match(/"hosted_count"\s*:\s*(\d+)/)?.[1];
  return count ? Number(count) : null;
}

async function syncProfile(userId: string, source: SyncSourceRow, scope: ResolvedSyncScope) {
  const { firecrawlDiscoverLumaEvents, firecrawlScrapeEvent, firecrawlScrapeSource, hasFirecrawl } =
    await import("./firecrawl.server");
  if (!hasFirecrawl()) throw new Error("FIRECRAWL_API_KEY missing");
  const url = source.calendar_url ?? "";
  const sourceBranding = await firecrawlScrapeSource(url);
  const profileUsername = new URL(url).pathname.split("/").filter(Boolean).at(-1)?.toLowerCase();
  const hostedCount = await profileHostedCount(url);
  const target = Math.min(Math.max(hostedCount ?? 80, 80), source.event_limit || 500);
  const urls = await firecrawlDiscoverLumaEvents(url, target);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: cached } = await supabaseAdmin
    .from("scraped_events" as never)
    .select("source_url,start_at,updated_at")
    .eq("user_id", userId)
    .eq("calendar_id", source.id);
  const cachedByUrl = new Map(
    (
      (cached as Array<{
        source_url: string;
        start_at: string | null;
        updated_at: string;
      }> | null) ?? []
    ).map((row) => [row.source_url, row]),
  );
  const { data: siblingSources } = await supabaseAdmin
    .from("user_luma_calendars" as never)
    .select(
      "calendar_name,calendar_avatar_url,calendar_cover_url,calendar_description,source_metadata",
    )
    .eq("user_id", userId);
  const relatedPersonal = (
    (siblingSources as Array<{
      calendar_name: string | null;
      calendar_avatar_url: string | null;
      calendar_cover_url: string | null;
      calendar_description: string | null;
      source_metadata: {
        personalUserId?: string | null;
        personalUsername?: string | null;
      } | null;
    }> | null) ?? []
  ).find(
    (candidate) =>
      Boolean(candidate.source_metadata?.personalUserId) &&
      candidate.source_metadata?.personalUsername?.toLowerCase() === profileUsername,
  );
  const staleBefore = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const toScrape = urls.filter((eventUrl) => {
    const row = cachedByUrl.get(eventUrl);
    if (!row) return true;
    return Date.parse(row.updated_at) < staleBefore && Date.parse(row.start_at ?? "") >= Date.now();
  });
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < toScrape.length; offset += 5) {
    const batch = await Promise.all(
      toScrape.slice(offset, offset + 5).map(async (eventUrl) => {
        const event = await firecrawlScrapeEvent(eventUrl);
        if (!event) return null;
        return {
          event_key: `scr-${stableHash(eventUrl)}`,
          source_url: eventUrl,
          name: event.name,
          description: event.description,
          cover_url: event.coverUrl,
          city: event.city,
          start_at: event.startAt,
          end_at: event.endAt,
          host_name: event.hostName,
          payload: {
            source: "profile",
            profileUrl: url,
            branding: event.branding ?? null,
            enrichment: event.enrichment,
          },
        };
      }),
    );
    for (const row of batch) {
      if (row) rows.push(row);
    }
  }
  if (relatedPersonal?.source_metadata?.personalUserId) {
    const { data: hostedRows } = await supabaseAdmin
      .from("scraped_events" as never)
      .select(
        "event_key,source_url,name,description,cover_url,city,start_at,end_at,host_name,payload",
      )
      .eq("user_id", userId);
    const personalUserId = relatedPersonal.source_metadata.personalUserId;
    for (const hosted of (hostedRows as Array<Record<string, unknown>> | null) ?? []) {
      const payload =
        hosted.payload && typeof hosted.payload === "object"
          ? (hosted.payload as Record<string, unknown>)
          : {};
      if (!Array.isArray(payload.hostIds) || !payload.hostIds.includes(personalUserId)) continue;
      if (rows.some((row) => row.source_url === hosted.source_url)) continue;
      rows.push({
        ...hosted,
        payload: { ...payload, source: "profile-host-match", profileUrl: url },
      });
    }
  }
  await upsertScrapedRows(userId, source, rows);
  const importedUrls = new Set(cachedByUrl.keys());
  for (const row of rows) importedUrls.add(String(row.source_url));
  return {
    discovered: urls.length,
    imported: importedUrls.size,
    remoteName:
      sourceBranding.name ??
      relatedPersonal?.calendar_name ??
      source.remote_name ??
      source.curated_name ??
      "Luma profile",
    avatarUrl:
      sourceBranding.avatarUrl ??
      relatedPersonal?.calendar_avatar_url ??
      sourceBranding.coverUrl ??
      null,
    coverUrl: sourceBranding.coverUrl ?? relatedPersonal?.calendar_cover_url ?? null,
    description: sourceBranding.description ?? relatedPersonal?.calendar_description ?? null,
    tintColor: null,
    metadata: {
      hostedCount,
      target,
      refreshed: rows.length,
      syncScope: scope.kind,
      emptyConfirmed: urls.length === 0 && rows.length === 0 && importedUrls.size === 0,
      nextEventAt:
        [...cachedByUrl.values(), ...rows]
          .map((row) =>
            "start_at" in row && typeof row.start_at === "string" ? row.start_at : null,
          )
          .filter((value): value is string => Boolean(value))
          .filter((value) => Date.parse(value) >= Date.now())
          .sort()[0] ?? null,
    },
    partial: hostedCount !== null && urls.length < hostedCount,
    warning: null,
    historicalComplete:
      scope.kind === "full" && !(hostedCount !== null && urls.length < hostedCount),
  };
}

function stableHash(value: string): string {
  let hash = 5381;
  for (const char of value) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}

function logJobOutcome(fields: {
  host: string | null;
  sourceId: string;
  status: string;
  attempt: number;
  retryAfterMs: number | null;
  pages: number | null;
}): void {
  console.info(
    JSON.stringify({
      event: "sync_job_outcome",
      host: fields.host,
      sourceId: fields.sourceId,
      status: fields.status,
      attempt: fields.attempt,
      retryAfterMs: fields.retryAfterMs,
      pages: fields.pages,
    }),
  );
}

export async function processNextSyncJob(
  userId?: string,
  sourceId?: string,
  skipped = 0,
): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let query = supabaseAdmin
    .from("event_sync_jobs" as never)
    .select("id,user_id,source_id,attempt,sync_scope")
    .eq("status", "queued")
    .lte("scheduled_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(1);
  if (userId) query = query.eq("user_id", userId);
  if (sourceId) query = query.eq("source_id", sourceId);
  const { data } = await query.maybeSingle();
  const job = data as {
    id: string;
    user_id: string;
    source_id: string;
    attempt: number;
    sync_scope: RequestedSyncScope;
  } | null;
  if (!job) return false;
  const { data: claimed } = await supabaseAdmin
    .from("event_sync_jobs" as never)
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      attempt: job.attempt + 1,
    } as never)
    .eq("id", job.id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (!claimed) return false;

  const { resolveCanonicalCalendarRowId, registerLumaCalendarIdentity, addCalendarAliases } =
    await import("./calendar-identity.server");
  const canonicalSourceId =
    (await resolveCanonicalCalendarRowId(job.user_id, job.source_id)) ?? job.source_id;
  const { data: sourceData } = await supabaseAdmin
    .from("user_luma_calendars" as never)
    .select(SOURCE_COLUMNS)
    .eq("id", canonicalSourceId)
    .single();
  if (!sourceData) throw new Error("Sync source not found");
  const source = sourceData as unknown as SyncSourceRow;
  if (shouldSkipLumaDuringCooldown(source.provider, isLumaHostCoolingDown()) && skipped < 20) {
    const cooldownUntil = Math.max(
      getHostCooldownUntil("api.lu.ma"),
      getHostCooldownUntil("public-api.luma.com"),
    );
    await supabaseAdmin
      .from("event_sync_jobs" as never)
      .update({
        status: "queued",
        scheduled_at: new Date(Math.max(Date.now(), cooldownUntil)).toISOString(),
        started_at: null,
        attempt: job.attempt,
        error: "Deferred while Luma host is in cooldown",
      } as never)
      .eq("id", job.id);
    await supabaseAdmin
      .from("user_luma_calendars" as never)
      .update({
        sync_status: rateLimitedSourceStatus(source.imported_count ?? 0),
        sync_error: "Waiting for Luma rate-limit cooldown",
      } as never)
      .eq("id", source.id);
    return processNextSyncJob(userId, sourceId, skipped + 1);
  }
  const scope = resolveSyncScope(source.historical_sync_completed_at, job.sync_scope ?? "auto");
  const attemptedAt = new Date().toISOString();
  await supabaseAdmin
    .from("user_luma_calendars" as never)
    .update({
      sync_status: "running",
      sync_error: null,
      last_sync_attempted_at: attemptedAt,
    } as never)
    .eq("id", source.id);

  try {
    const result =
      source.provider !== "luma" && source.provider_connection_id
        ? await syncConnectedProvider(job.user_id, source, scope)
        : source.provider !== "luma"
          ? await syncPublicProvider(job.user_id, source, scope)
          : selectLumaSyncPath(source) === "api"
            ? await syncApiCalendar(job.user_id, source, scope)
            : selectLumaSyncPath(source) === "profile"
              ? await syncProfile(job.user_id, source, scope)
              : await syncCalendar(job.user_id, source, scope);
    const persistedImported =
      (await countPersistedEventsForSource(job.user_id, source.id)) ?? result.imported;
    const status = "partial" in result && result.partial ? "partial" : "completed";
    const suggestion = suggestedGroup(source, result.description);
    const now = new Date();
    const next = new Date(
      now.getTime() + (status === "partial" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000),
    ).toISOString();
    await supabaseAdmin
      .from("user_luma_calendars" as never)
      .update({
        remote_name: result.remoteName,
        sync_status: status,
        sync_error: result.warning,
        discovered_count: result.discovered,
        imported_count: persistedImported,
        source_metadata: { ...(source.source_metadata ?? {}), ...result.metadata },
        calendar_avatar_url: result.avatarUrl ?? source.calendar_avatar_url,
        calendar_cover_url: result.coverUrl ?? source.calendar_cover_url,
        calendar_description: result.description ?? source.calendar_description,
        calendar_tint_color: result.tintColor ?? source.calendar_tint_color,
        calendar_slug:
          "slug" in result.metadata && typeof result.metadata.slug === "string"
            ? result.metadata.slug
            : undefined,
        metadata_version: CALENDAR_METADATA_VERSION,
        suggested_group_name: source.group_id ? null : suggestion.name,
        suggested_group_reason: source.group_id ? null : suggestion.reason,
        last_synced_at: now.toISOString(),
        last_sync_attempted_at: attemptedAt,
        last_sync_scope: scope.kind,
        historical_sync_completed_at: result.historicalComplete
          ? now.toISOString()
          : source.historical_sync_completed_at,
        next_sync_at: next,
      } as never)
      .eq("id", source.id);
    const discoveredIdentity =
      "lumaCalendarId" in result.metadata && typeof result.metadata.lumaCalendarId === "string"
        ? result.metadata.lumaCalendarId
        : null;
    if (discoveredIdentity) {
      const winnerId = await registerLumaCalendarIdentity(
        job.user_id,
        source.id,
        discoveredIdentity,
      );
      await addCalendarAliases(job.user_id, winnerId, [
        { value: source.calendar_id, kind: "legacy_id" },
        { value: source.calendar_url, kind: "url" },
        { value: discoveredIdentity, kind: "luma_id" },
        {
          value:
            "slug" in result.metadata && typeof result.metadata.slug === "string"
              ? result.metadata.slug
              : null,
          kind: "slug",
        },
      ]);
      if (winnerId !== source.id) await enqueueSource(job.user_id, winnerId, "scheduled");
    }
    await supabaseAdmin
      .from("event_sync_jobs" as never)
      .update({
        status,
        discovered_count: result.discovered,
        imported_count: persistedImported,
        finished_at: now.toISOString(),
      } as never)
      .eq("id", job.id);
    logJobOutcome({
      host: source.provider === "luma" ? "api.lu.ma" : source.provider,
      sourceId: source.id,
      status,
      attempt: job.attempt + 1,
      retryAfterMs: null,
      pages:
        "pages" in result.metadata && typeof result.metadata.pages === "number"
          ? result.metadata.pages
          : null,
    });
  } catch (error) {
    if (error instanceof RateLimitedError) {
      const attempt = job.attempt + 1;
      const plan = rateLimitedJobPlan(attempt, error.retryAfterMs);
      const sourceStatus = rateLimitedSourceStatus(source.imported_count ?? 0);
      const message = `Luma rate limited (${error.host}); retrying after ${Math.ceil(plan.retryAfterMs / 1000)}s`;
      await supabaseAdmin
        .from("user_luma_calendars" as never)
        .update({
          sync_status: sourceStatus,
          sync_error: message,
          last_sync_attempted_at: attemptedAt,
          last_sync_scope: scope.kind,
          next_sync_at: plan.scheduledAt,
        } as never)
        .eq("id", source.id);
      await supabaseAdmin
        .from("event_sync_jobs" as never)
        .update({
          status: plan.status,
          scheduled_at: plan.scheduledAt,
          started_at: null,
          error: message,
          finished_at: plan.status === "failed" ? new Date().toISOString() : null,
        } as never)
        .eq("id", job.id);
      logJobOutcome({
        host: error.host,
        sourceId: source.id,
        status: plan.status,
        attempt,
        retryAfterMs: plan.retryAfterMs,
        pages: null,
      });
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    const unreachable = /not publicly accessible/i.test(message);
    const transient = /rate|429|5\d\d|temporar|timeout|fetch failed/i.test(message);
    // A source that already imported events keeps its history and is reported
    // as partial instead of being demoted to "inaccessible".
    const keepsHistory = (source.imported_count ?? 0) > 0;
    await supabaseAdmin
      .from("user_luma_calendars" as never)
      .update({
        sync_status: unreachable ? (keepsHistory ? "partial" : "inaccessible") : "failed",
        sync_error: message,
        last_sync_attempted_at: attemptedAt,
        last_sync_scope: scope.kind,
        next_sync_at: new Date(
          Date.now() + (transient ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000),
        ).toISOString(),
      } as never)
      .eq("id", source.id);
    await supabaseAdmin
      .from("event_sync_jobs" as never)
      .update({ status: "failed", error: message, finished_at: new Date().toISOString() } as never)
      .eq("id", job.id);
    logJobOutcome({
      host: source.provider === "luma" ? "api.lu.ma" : source.provider,
      sourceId: source.id,
      status: "failed",
      attempt: job.attempt + 1,
      retryAfterMs: null,
      pages: null,
    });
  }
  const { error: cleanupError } = await supabaseAdmin.rpc(
    "cleanup_merged_calendar_rows" as never,
    { p_user_id: job.user_id } as never,
  );
  if (cleanupError && !/schema cache|does not exist/i.test(cleanupError.message)) {
    console.warn("[calendar-sync] merged calendar cleanup failed", cleanupError.message);
  }
  const { invalidateEventLibraryStatsCache } = await import("./event-library-stats.functions");
  invalidateEventLibraryStatsCache(job.user_id);
  return true;
}

export async function recoverStaleSyncLeases(userId?: string): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  let query = supabaseAdmin
    .from("event_sync_jobs" as never)
    .update({
      status: "queued",
      scheduled_at: new Date().toISOString(),
      started_at: null,
      error: "Recovered stale worker lease",
    } as never)
    .eq("status", "running")
    .lt("started_at", stale);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query.select("id");
  if (error) throw new Error(error.message);
  return (data as Array<{ id: string }> | null)?.length ?? 0;
}

export async function recoverOrphanQueuedSources(): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: stuck, error } = await supabaseAdmin
    .from("user_luma_calendars" as never)
    .select("id,user_id")
    .eq("sync_status", "queued")
    .eq("sync_enabled", true)
    .is("merged_into_id", null)
    .limit(500);
  if (error) throw new Error(error.message);
  let recovered = 0;
  for (const row of (stuck as Array<{ id: string; user_id: string }> | null) ?? []) {
    const { count } = await supabaseAdmin
      .from("event_sync_jobs" as never)
      .select("id", { count: "exact", head: true })
      .eq("source_id", row.id)
      .in("status", ["queued", "running"]);
    if (!count) {
      await enqueueSource(row.user_id, row.id, "scheduled");
      recovered += 1;
    }
  }
  return recovered;
}

export async function processSyncQueueForUser(
  userId: string,
  maxJobs = 4,
  sourceIds?: string[],
): Promise<{ processed: number; remaining: number }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await recoverStaleSyncLeases(userId);

  let processed = 0;
  let requestedSourceIds = sourceIds?.slice(0, maxJobs);
  if (!requestedSourceIds) {
    const { data: meetupSources } = await supabaseAdmin
      .from("user_luma_calendars" as never)
      .select("id")
      .eq("user_id", userId)
      .eq("provider", "meetup")
      .eq("sync_status", "queued")
      .is("merged_into_id", null)
      .limit(maxJobs);
    requestedSourceIds = ((meetupSources as Array<{ id: string }> | null) ?? []).map(
      (source) => source.id,
    );
  }
  for (const sourceId of requestedSourceIds) {
    if (await processNextSyncJob(userId, sourceId)) processed++;
  }
  if (!sourceIds) {
    while (processed < maxJobs && (await processNextSyncJob(userId))) processed++;
  }
  const { count } = await supabaseAdmin
    .from("event_sync_jobs" as never)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["queued", "running"]);
  return { processed, remaining: count ?? 0 };
}

export async function enqueueDueSources(): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_luma_calendars" as never)
    .select("id,user_id")
    .eq("sync_enabled", true)
    .is("merged_into_id", null)
    .lte("next_sync_at", new Date().toISOString());
  const rows = (data as Array<{ id: string; user_id: string }> | null) ?? [];
  for (const row of rows) await enqueueSource(row.user_id, row.id, "scheduled");
  return rows.length;
}
