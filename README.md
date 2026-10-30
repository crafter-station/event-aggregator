# Event Aggregator

One canonical event library for Luma, Eventbrite, Meetup, and imported public links.

## What it does

Event calendars are fragmented. The same event can appear in several providers with different IDs, titles, images, and update schedules. Event Aggregator turns those sightings into one dependable library.

- Connect provider accounts or import public calendar and event links.
- Normalize provider data into one consistent event shape.
- Deduplicate repeated events while preserving every source.
- Filter by provider, ownership, date, location, language, format, topic, and audience.
- Mark calendars as **Mine** for focused views and integrations.
- Expose the library through a token-authenticated REST API and OAuth-backed MCP server.
- Monitor historical and maintenance syncs from Settings.

## Architecture

```text
Luma API / public Luma / Meetup / Eventbrite
                    │
                    ▼
       Provider adapters and fallbacks
   API → structured metadata → Firecrawl
                    │
                    ▼
 Canonical identity, deduplication, enrichment
          │              │              │
          ▼              ▼              ▼
       Web UI          REST API       MCP server
```

`canonicalId` is the stable event identity used by integrations. Source records preserve provider-specific IDs, calendars, URLs, and sync timestamps for attribution and reconciliation.

## Product areas

- **Events** — search, filter, sort, export, and inspect the unified library.
- **Import** — add a public calendar, organizer, group, or individual event URL.
- **Settings** — manage provider connections, persistent sync, calendar groups, ownership, API tokens, and MCP access.
- **Admin** — review the global contributed catalog with region and audience context.

## API quick start

1. Open **Settings → API and MCP access**.
2. Create a token and copy it when shown.
3. Request events:

```bash
curl \
  -H "Authorization: Bearer luma_sk_..." \
  "https://your-deployment.example/api/v1/events?calendar=all&status=upcoming&limit=50"
```

REST endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/health` | Public availability check. |
| `GET /api/v1/calendars` | Calendars, groups, ownership, counts, and sync health. |
| `GET /api/v1/events` | Canonical or source-level events with filters and pagination. |
| `GET /api/v1/events/{canonicalId}` | One canonical event. |
| `GET /api/v1/changes` | Incremental upserts and delete tombstones. Also available at `/api/v1/events/changes`. |

The MCP server exposes `whoami`, `list_calendars`, and `list_events` at `/mcp`.

See [docs/api.md](docs/api.md) and [docs/openapi.yaml](docs/openapi.yaml).

## Security

- REST tokens are user-scoped, shown once, stored as hashes, and revocable.
- Provider credentials are encrypted and remain tied to the signed-in account.
- Row-level policies protect user-owned calendars, groups, tags, and tokens.
- Server-only keys never belong in browser code or committed environment files.

## Local development

```bash
bun install
bun run dev
```

Useful commands:

```bash
bun run dev
bun run build
bun test
bun run lint
bun run format
```

## Repository map

```text
src/routes/_authenticated/   Events, import, settings, and admin UI
src/routes/api/v1/           Token-authenticated REST endpoints
src/lib/events-aggregate*    Canonicalization and source lineage
src/lib/event-providers*     Provider detection and ingestion adapters
src/lib/event-tags*          Taxonomy and saved views
docs/api.md                  Integration guide
docs/openapi.yaml            Machine-readable API contract
```
