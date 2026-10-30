export async function handleChangesRequest(request: Request): Promise<Response> {
  const {
    apiError,
    authFromRequest,
    checkRateLimit,
    rateLimitHeaders,
    clampInt,
    requireScope,
    json,
  } = await import("@/lib/api-v1.server");
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return apiError(401, "missing_token", "Authorization header is required");
  const auth = await authFromRequest(request);
  if (!auth) return apiError(401, "invalid_token", "Token is invalid, revoked, or expired");
  const rateLimited = checkRateLimit(auth.tokenId);
  if (rateLimited) return rateLimited;
  const scopeError = requireScope(auth, "changes:read");
  if (scopeError) return scopeError;
  const params = new URL(request.url).searchParams;
  const sinceRaw = params.get("since") ?? "0";
  if (!/^\d+$/.test(sinceRaw)) {
    return apiError(400, "bad_params", "since must be an opaque numeric cursor");
  }
  const limit = clampInt(params.get("limit"), 500, 1, 500);
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("event_change_log" as never)
      .select("id,canonical_event_id,operation,event_snapshot,changed_at")
      .eq("user_id", auth.userId)
      .gt("id", sinceRaw)
      .order("id", { ascending: true })
      .limit(limit + 1);
    if (error) throw new Error(error.message);
    const rows =
      (data as Array<{
        id: number;
        canonical_event_id: string | null;
        operation: "upsert" | "delete";
        event_snapshot: Record<string, unknown> | null;
        changed_at: string;
      }> | null) ?? [];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const normalizeSnapshot = (
      snapshot: Record<string, unknown>,
      changedAt: string,
      id: string | null,
    ) => ({
      canonicalId: id,
      name: snapshot.name ?? null,
      url: snapshot.url ?? null,
      coverUrl: snapshot.cover_url ?? null,
      startAt: snapshot.start_at ?? null,
      endAt: snapshot.end_at ?? null,
      city: snapshot.city ?? null,
      description: snapshot.description ?? null,
      hostName: snapshot.host_name ?? null,
      timezone: snapshot.timezone ?? null,
      enrichment: snapshot.enrichment ?? {},
      externalIds: snapshot.external_ids ?? {},
      updatedAt: snapshot.updated_at ?? changedAt,
      changedAt,
    });
    return json(
      200,
      {
        upserts: page
          .filter((row) => row.operation === "upsert" && row.event_snapshot)
          .map((row) =>
            normalizeSnapshot(row.event_snapshot ?? {}, row.changed_at, row.canonical_event_id),
          ),
        deletes: page
          .filter((row) => row.operation === "delete")
          .map((row) => ({ canonicalId: row.canonical_event_id, changedAt: row.changed_at })),
        nextCursor: last ? String(last.id) : sinceRaw,
        hasMore: rows.length > limit,
        generatedAt: new Date().toISOString(),
      },
      rateLimitHeaders(auth.tokenId),
    );
  } catch (error) {
    console.error("[/api/v1/changes] failed", error);
    return apiError(500, "server_error", "Unable to read event changes");
  }
}
