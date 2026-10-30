import { defineMcp } from "@lovable.dev/mcp-js";
import { createTanStackMcpHandler } from "@lovable.dev/mcp-js/stacks/tanstack";
import oauthMcp from "./index";
import { buildTokenTools } from "./token-tools";
import type { TokenPrincipal } from "./principal";
import { assertTokenToolsReadOnly } from "./principal";

export const MCP_RUNTIME_OPTIONS = {
  resourcePath: "/mcp",
  metadataPath: "/.well-known/oauth-protected-resource",
  trustForwardedHost: true,
} as const;

const oauthHandler = createTanStackMcpHandler(oauthMcp, MCP_RUNTIME_OPTIONS);

export function lumaSkTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(luma_sk_\S+)/i);
  return match?.[1] ?? null;
}

export function resourceMetadataUrl(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) return `${proto}://${forwardedHost}${MCP_RUNTIME_OPTIONS.metadataPath}`;
  return `${new URL(request.url).origin}${MCP_RUNTIME_OPTIONS.metadataPath}`;
}

export function unauthorizedTokenResponse(request: Request): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": `Bearer realm="mcp", error="invalid_token", resource_metadata="${resourceMetadataUrl(request)}"`,
    },
  });
}

export function buildTokenMcp(principal: TokenPrincipal) {
  const tools = buildTokenTools(principal);
  assertTokenToolsReadOnly(tools);
  return defineMcp({
    name: "event-aggregator-mcp",
    title: "Event Aggregator",
    version: "0.4.0",
    instructions:
      "Tools for Event Aggregator. Read the signed-in user's connected calendars and consolidated events across Luma, Eventbrite, and Meetup. Use list_calendars, then list_events (filters: mine, calendar_id, status, q, from/to; paginate with cursor), and get_event for full details and sources. Use whoami to verify connectivity.",
    tools,
  });
}

export type McpHttpDeps = {
  verifyApiToken?: (
    raw: string,
  ) => Promise<{ userId: string; tokenId: string; scopes: string[] } | null>;
  checkRateLimit?: (tokenId: string) => Response | null;
  serveTokenMcp?: (principal: TokenPrincipal, ctx: { request: Request }) => Promise<Response>;
};

export async function handleMcpRequest(
  ctx: { request: Request },
  oauth = oauthHandler,
  deps: McpHttpDeps = {},
): Promise<Response> {
  const raw = lumaSkTokenFromRequest(ctx.request);
  if (!raw) return oauth(ctx);

  const verify = deps.verifyApiToken ?? (await import("@/lib/api-tokens.server")).verifyApiToken;
  const checkRateLimit =
    deps.checkRateLimit ?? (await import("@/lib/api-v1.server")).checkRateLimit;
  const verified = await verify(raw);
  if (!verified) return unauthorizedTokenResponse(ctx.request);
  const limited = checkRateLimit(verified.tokenId);
  if (limited) return limited;
  const principal: TokenPrincipal = {
    kind: "api_token",
    userId: verified.userId,
    tokenId: verified.tokenId,
    scopes: verified.scopes,
  };
  if (deps.serveTokenMcp) return deps.serveTokenMcp(principal, ctx);
  const handler = createTanStackMcpHandler(buildTokenMcp(principal), MCP_RUNTIME_OPTIONS);
  return handler(ctx);
}
