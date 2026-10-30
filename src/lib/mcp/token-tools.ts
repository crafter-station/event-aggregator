import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { fail } from "./supabase";
import { assertTokenToolsReadOnly, missingScope, type TokenPrincipal } from "./principal";
import { getEventForToken, listEventsForToken, loadCalendarsForToken } from "./token-data";

export function buildTokenTools(principal: TokenPrincipal) {
  const whoami = defineTool({
    name: "whoami",
    title: "Who am I",
    description: "Return the signed-in user's id and email as seen by the MCP server.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: async () => {
      const info = {
        user_id: principal.userId,
        auth: "api_token" as const,
        scopes: principal.scopes,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
        structuredContent: info,
      };
    },
  });

  const listCalendars = defineTool({
    name: "list_calendars",
    title: "List my calendars",
    description:
      "List the signed-in user's connected calendars (Luma, Eventbrite, Meetup, or link-imported). Use mine=true for calendars marked as the user's own.",
    inputSchema: {
      mine: z
        .boolean()
        .optional()
        .describe("Filter to calendars marked as the user's own (true) or not (false)."),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: async ({ mine }) => {
      const scope = missingScope(principal, "calendars:read");
      if (scope) return fail(`insufficient_scope: ${scope}`);
      const result = await loadCalendarsForToken(principal.userId);
      if (!result.ok) return fail("Could not load calendars");
      const calendars = result.rows
        .filter((r) => mine === undefined || r.is_mine === mine)
        .map(({ id: _rowId, ...rest }) => rest);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(calendars, null, 2) }],
        structuredContent: { calendars },
      };
    },
  });

  const listEvents = defineTool({
    name: "list_events",
    title: "List my events",
    description:
      "List the signed-in user's consolidated events across connected calendars, with filters for ownership, calendar, status, date range and name search. Paginate with cursor.",
    inputSchema: {
      mine: z
        .boolean()
        .optional()
        .describe("true = only calendars marked as mine; false = only others."),
      calendar_id: z
        .string()
        .optional()
        .describe("Restrict to one calendar (calendar_id from list_calendars)."),
      status: z
        .enum(["all", "upcoming", "past"])
        .optional()
        .describe("upcoming includes ongoing events. Default all."),
      q: z.string().max(200).optional().describe("Case-insensitive search in event name."),
      from: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("Only events starting at/after this ISO time."),
      to: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("Only events starting before this ISO time."),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25)."),
      cursor: z.string().regex(/^\d+$/).optional().describe("nextCursor from a previous call."),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (input) => {
      const scope = missingScope(principal, "events:read");
      if (scope) return fail(`insufficient_scope: ${scope}`);
      return listEventsForToken(principal.userId, input);
    },
  });

  const getEvent = defineTool({
    name: "get_event",
    title: "Get event details",
    description:
      "Get one consolidated event by id (from list_events), including description, venue, tags and every source it was found in.",
    inputSchema: { id: z.string().uuid().describe("Event id from list_events.") },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: async ({ id }) => {
      const scope = missingScope(principal, "events:read");
      if (scope) return fail(`insufficient_scope: ${scope}`);
      return getEventForToken(principal.userId, id);
    },
  });

  const tools = [whoami, listCalendars, listEvents, getEvent];
  assertTokenToolsReadOnly(tools);
  return tools;
}
