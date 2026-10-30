import { describe, expect, test } from "bun:test";
import { assertTokenToolsReadOnly, missingScope } from "../mcp/principal";
import { handleMcpRequest } from "../mcp/http";
import { buildTokenTools } from "../mcp/token-tools";
import {
  createRecordingClient,
  getEventForToken,
  listEventsForToken,
  loadCalendarsForToken,
  tokenQueryHasUserFilter,
} from "../mcp/token-data";

const oauth = async () => new Response("oauth-handler");

describe("MCP token path", () => {
  test("OAuth JWT requests still go to the original handler", async () => {
    const response = await handleMcpRequest(
      {
        request: new Request("https://eventrouter.lovable.app/mcp", {
          method: "POST",
          headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" },
        }),
      },
      oauth,
    );
    expect(await response.text()).toBe("oauth-handler");
  });

  test("revoked, expired or unknown tokens get 401", async () => {
    const response = await handleMcpRequest(
      {
        request: new Request("https://eventrouter.lovable.app/mcp", {
          method: "POST",
          headers: { authorization: "Bearer luma_sk_unknown" },
        }),
      },
      oauth,
      { verifyApiToken: async () => null },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("a valid token reaches whoami, list_calendars, list_events and get_event", async () => {
    const seen: string[] = [];
    const principal = {
      kind: "api_token" as const,
      userId: "user-1",
      tokenId: "tok-1",
      scopes: ["events:read", "calendars:read"],
    };
    const response = await handleMcpRequest(
      {
        request: new Request("https://eventrouter.lovable.app/mcp", {
          method: "POST",
          headers: { authorization: "Bearer luma_sk_valid" },
        }),
      },
      oauth,
      {
        verifyApiToken: async () => ({
          userId: principal.userId,
          tokenId: principal.tokenId,
          scopes: principal.scopes,
        }),
        checkRateLimit: () => null,
        serveTokenMcp: async (received) => {
          const tools = buildTokenTools(received);
          for (const tool of tools) seen.push(tool.name);
          return Response.json({ ok: true, user: received.userId });
        },
      },
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual(["whoami", "list_calendars", "list_events", "get_event"]);
    const whoami = await buildTokenTools(principal)[0].handler({}, {} as never);
    expect(whoami.structuredContent).toEqual({
      user_id: "user-1",
      auth: "api_token",
      scopes: ["events:read", "calendars:read"],
    });
  });

  test("a missing scope gets insufficient_scope", async () => {
    expect(
      missingScope(
        { kind: "api_token", userId: "u", tokenId: "t", scopes: ["calendars:read"] },
        "events:read",
      ),
    ).toBe("events:read");
    const tools = buildTokenTools({
      kind: "api_token",
      userId: "u",
      tokenId: "t",
      scopes: ["calendars:read"],
    });
    const result = await tools[2].handler({}, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: "insufficient_scope: events:read" });
  });

  test("every token query includes the user_id filter", async () => {
    const client = createRecordingClient("user-1", {
      user_luma_calendars: [],
      canonical_events: [],
    });
    await loadCalendarsForToken("user-1", client);
    await listEventsForToken("user-1", { calendar_id: "cal-1" }, client);
    await getEventForToken("user-1", "00000000-0000-0000-0000-000000000001", client);
    expect(tokenQueryHasUserFilter(client.steps, "user-1")).toBe(true);
  });

  test("the token server rejects a non-read-only tool", () => {
    expect(() =>
      assertTokenToolsReadOnly([{ name: "write_event", annotations: { readOnlyHint: false } }]),
    ).toThrow(/write_event/);
  });
});
