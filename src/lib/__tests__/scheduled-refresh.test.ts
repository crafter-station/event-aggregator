import { describe, expect, it } from "bun:test";
import { selectDueForAutoRefresh } from "../scheduled-refresh";

const now = Date.parse("2026-10-27T06:00:00Z");
const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString();
const row = (id: string, at: string | null, sync_status = "synced") => ({ id, user_id: "u", sync_status, last_sync_attempted_at: at });

describe("auto refresh every 3 days", () => {
  it("refreshes sources last tried 3+ days ago, not ones tried 1 day ago", () => {
    const ids = selectDueForAutoRefresh([row("a", daysAgo(3)), row("b", daysAgo(1))], now).map((r) => r.id);
    expect(ids).toEqual(["a"]);
  });
  it("skips unreachable sources until refreshed by hand", () => {
    expect(selectDueForAutoRefresh([row("a", daysAgo(10), "inaccessible")], now)).toEqual([]);
  });
  it("oldest first, never-synced before all", () => {
    const ids = selectDueForAutoRefresh([row("a", daysAgo(4)), row("b", null), row("c", daysAgo(9))], now).map((r) => r.id);
    expect(ids).toEqual(["b", "c", "a"]);
  });
});
