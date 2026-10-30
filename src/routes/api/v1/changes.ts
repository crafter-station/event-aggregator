import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/changes")({
  server: {
    handlers: {
      OPTIONS: async () => {
        const { CORS } = await import("@/lib/api-v1.server");
        return new Response(null, { status: 204, headers: CORS });
      },
      GET: async ({ request }) => {
        const { handleChangesRequest } = await import("@/lib/api-v1-changes.server");
        return handleChangesRequest(request);
      },
    },
  },
});
