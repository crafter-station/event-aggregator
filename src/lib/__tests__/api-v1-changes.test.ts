import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Route } from "../../routes/api/v1/changes";

describe("GET /api/v1/changes", () => {
  test("is registered on the route tree so token clients do not get 404 HTML", () => {
    const tree = readFileSync(new URL("../../routeTree.gen.ts", import.meta.url), "utf8");
    expect(tree).toContain("'/api/v1/changes'");
    expect(Route.options.server?.handlers?.GET).toBeTypeOf("function");
  });

  test("GET without a token returns JSON 401, not the app HTML", async () => {
    const response = await Route.options.server!.handlers!.GET!({
      request: new Request("https://eventrouter.lovable.app/api/v1/changes?since=0&limit=1"),
    } as never);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toMatch(/json/);
    expect(await response.json()).toMatchObject({ error: "missing_token" });
  });
});
