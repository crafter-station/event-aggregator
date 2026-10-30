export const CATALOG_REQUEUE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const SYNC_RESUME_TTL_MS = 24 * 60 * 60 * 1000;
export const RATE_LIMIT_ATTEMPT_CAP = 5;

export type LumaSyncPath = "api" | "profile" | "calendar";

export type SyncResume = {
  scope: "full" | "maintenance";
  period?: "future" | "past";
  cursor: string | null;
  pages: number | { future: number; past: number };
  updatedAt: string;
};

export type CatalogSourceSnapshot = {
  metadata_version?: number | null;
  calendar_avatar_url?: string | null;
  calendar_cover_url?: string | null;
  imported_count?: number | null;
  last_sync_attempted_at?: string | null;
  sync_status?: string | null;
  source_metadata?: Record<string, unknown> | null;
};

export function hasApiKeyCiphertext(source: { api_key_ciphertext?: string | null }): boolean {
  return Boolean(source.api_key_ciphertext);
}

export function selectLumaSyncPath(source: {
  source_kind?: "api" | "calendar" | "profile" | "event" | null;
  api_key_ciphertext?: string | null;
}): LumaSyncPath {
  if (source.source_kind === "api" || (source.source_kind == null && hasApiKeyCiphertext(source))) {
    return "api";
  }
  if (source.source_kind === "profile") return "profile";
  return "calendar";
}

export function shouldEnqueueCatalogRefresh(
  row: CatalogSourceSnapshot,
  metadataVersion: number,
  now = Date.now(),
): boolean {
  const attemptedAt = row.last_sync_attempted_at;
  if (attemptedAt && now - Date.parse(attemptedAt) < CATALOG_REQUEUE_COOLDOWN_MS) {
    return false;
  }
  const completed = row.sync_status === "completed" || row.sync_status === "partial";
  const onlyMissingImages =
    completed &&
    (row.metadata_version ?? 0) >= metadataVersion &&
    ((row.imported_count ?? 0) > 0 || Boolean(row.source_metadata?.emptyConfirmed));
  if (onlyMissingImages && (!row.calendar_avatar_url || !row.calendar_cover_url)) {
    return false;
  }
  return (
    (row.metadata_version ?? 0) < metadataVersion ||
    !row.calendar_avatar_url ||
    !row.calendar_cover_url ||
    ((row.imported_count ?? 0) === 0 && !row.source_metadata?.emptyConfirmed)
  );
}

export function readFreshSyncResume(
  metadata: Record<string, unknown> | null | undefined,
  now = Date.now(),
): SyncResume | null {
  const raw = metadata?.syncResume;
  if (!raw || typeof raw !== "object") return null;
  const resume = raw as Partial<SyncResume>;
  if (typeof resume.updatedAt !== "string") return null;
  if (now - Date.parse(resume.updatedAt) > SYNC_RESUME_TTL_MS) return null;
  if (resume.scope !== "full" && resume.scope !== "maintenance") return null;
  return {
    scope: resume.scope,
    period: resume.period === "past" || resume.period === "future" ? resume.period : undefined,
    cursor: typeof resume.cursor === "string" ? resume.cursor : null,
    pages: resume.pages ?? 0,
    updatedAt: resume.updatedAt,
  };
}

export function rateLimitedJobPlan(
  attempt: number,
  retryAfterMs: number,
  now = Date.now(),
  random = Math.random,
): { status: "queued" | "failed"; scheduledAt: string; retryAfterMs: number } {
  const jitter = Math.floor(random() * 250);
  const delay = Math.max(0, retryAfterMs) + jitter;
  if (attempt >= RATE_LIMIT_ATTEMPT_CAP) {
    return {
      status: "failed",
      scheduledAt: new Date(now + delay).toISOString(),
      retryAfterMs: delay,
    };
  }
  return {
    status: "queued",
    scheduledAt: new Date(now + delay).toISOString(),
    retryAfterMs: delay,
  };
}

export function shouldSkipLumaDuringCooldown(provider: string, cooling: boolean): boolean {
  return provider === "luma" && cooling;
}

export function filterRunnableJobs<T extends { provider: string }>(
  jobs: T[],
  cooling: boolean,
): T[] {
  return jobs.filter((job) => !shouldSkipLumaDuringCooldown(job.provider, cooling));
}

export function rateLimitedSourceStatus(importedCount: number): "partial" | "queued" {
  return importedCount > 0 ? "partial" : "queued";
}
