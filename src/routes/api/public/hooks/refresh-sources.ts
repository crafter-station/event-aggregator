import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { selectDueForAutoRefresh } from "@/lib/scheduled-refresh";

const TIME_BUDGET_MS = 25_000;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/public/hooks/refresh-sources")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const started = Date.now();
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { enqueueSource, processNextSyncJob } = await import("@/lib/calendar-sync.server");
        const { data, error } = await supabaseAdmin
          .from("user_luma_calendars")
          .select("id,user_id,sync_status,last_sync_attempted_at")
          .eq("sync_enabled", true)
          .is("merged_into_id", null)
          .limit(5000);
        if (error) return Response.json({ error: error.message }, { status: 500 });
        const due = selectDueForAutoRefresh(data ?? []);
        for (const row of due) await enqueueSource(row.user_id, row.id, "scheduled", undefined, "maintenance");
        let processed = 0;
        while (Date.now() - started < TIME_BUDGET_MS && (await processNextSyncJob())) processed++;
        return Response.json({ queued: due.length, processed });
      },
    },
  },
});
