export const AUTO_REFRESH_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

export type RefreshCandidate = {
  id: string;
  user_id: string;
  sync_status: string;
  last_sync_attempted_at: string | null;
};

/** Sources due for the 3-day auto refresh, oldest attempt first. Unreachable sources wait for a manual refresh. */
export function selectDueForAutoRefresh<T extends RefreshCandidate>(rows: T[], now = Date.now()): T[] {
  const cutoff = now - AUTO_REFRESH_INTERVAL_MS + 60 * 60 * 1000; // 1h slack for cron jitter
  return rows
    .filter((r) => r.sync_status !== "inaccessible" && r.sync_status !== "queued" && r.sync_status !== "running")
    .filter((r) => !r.last_sync_attempted_at || Date.parse(r.last_sync_attempted_at) <= cutoff)
    .sort((a, b) => (a.last_sync_attempted_at ? Date.parse(a.last_sync_attempted_at) : 0) - (b.last_sync_attempted_at ? Date.parse(b.last_sync_attempted_at) : 0));
}
