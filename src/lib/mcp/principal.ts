export type TokenPrincipal = {
  kind: "api_token";
  userId: string;
  tokenId: string;
  scopes: string[];
};

export type OAuthPrincipal = {
  kind: "oauth";
};

export type Principal = TokenPrincipal | OAuthPrincipal;

export function missingScope(principal: TokenPrincipal, scope: string): string | null {
  return principal.scopes.includes(scope) ? null : scope;
}

export function assertTokenToolsReadOnly(
  tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>,
): void {
  for (const tool of tools) {
    if (tool.annotations?.readOnlyHint !== true) {
      throw new Error(`Token MCP refused non-read-only tool: ${tool.name}`);
    }
  }
}
