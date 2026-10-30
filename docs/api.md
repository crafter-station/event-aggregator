# Event Aggregator API

This document covers the public integration surface for pulling a user's
canonical calendars and events from Event Aggregator into another app. The service
supports Luma, Eventbrite, and Meetup sources while preserving source lineage,
provider identity, enrichment, taxonomy labels, and sync metadata.

There are two API surfaces:

- **Event Aggregator REST API**: simple Bearer-token JSON endpoints for apps,
  scripts, automations, and backends.
- **MCP server**: OAuth-backed tool endpoints for MCP-capable clients.

## Base URL

Use the deployed app origin:

```txt
https://your-event-aggregator.example
```

In local development this is usually:

```txt
http://localhost:3000
```

For integrations running outside Lovable, use a **published deployment with
public access** (`*.lovable.app` or a custom domain). Lovable preview and
sandbox hosts (`*.lovableproject.com`) can be protected by the Lovable auth
gateway and return an HTTP 302 to login before the API route runs. That is a
hosting-gateway redirect, not an API response. The published app still keeps
event data protected with the Bearer token described below.

Verify the origin before configuring a client:

```bash
curl -i "https://your-event-aggregator.example/api/v1/health"
# {"ok":true,"service":"event-aggregator","apiVersion":"v1"}
```

## Authentication

Create an external API token in the app:

1. Open **Settings**.
2. Go to **API and MCP access**.
3. Create a token.
4. Copy it immediately. The raw token is shown only once.

Send it on every REST request:

```http
Authorization: Bearer luma_sk_...
```

Tokens are scoped to the signed-in user that created them. The server stores
only a SHA-256 hash, so a token cannot be recovered after creation. Revoke a
token from Settings if it leaks.

Tokens support `events:read`, `calendars:read`, and `changes:read` scopes. The
default token created by Settings has all three read scopes. Tokens may expire
and are rate-limited per token.

## Quick Start

```bash
curl -H "Authorization: Bearer luma_sk_..." \
  "https://your-event-aggregator.example/api/v1/events?calendar=all&limit=50"
```

```ts
const apiBase = "https://your-event-aggregator.example";
const token = process.env.EVENT_AGGREGATOR_API_TOKEN!;

async function eventAggregatorFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

const { events } = await eventAggregatorFetch<EventsResponse>(
  "/api/v1/events?calendar=all&limit=50",
);
```

## REST Endpoints

### `GET /api/v1/health`

Unauthenticated liveness check for deployment and integration setup. It never
redirects in the application and returns CORS headers with `Cache-Control:
no-store`.

```json
{ "ok": true, "service": "event-aggregator", "apiVersion": "v1" }
```

### `GET /api/v1/calendars`

Lists the caller's connected and imported calendars. Use this to discover valid
`calendar` filter values, provider identities, groups, images, event counts,
and sync status for `/api/v1/events`.

```bash
curl -H "Authorization: Bearer luma_sk_..." \
  "https://your-event-aggregator.example/api/v1/calendars"
```

Response:

```json
{
  "groups": [
    {
      "id": "b53ea106-79d1-45fe-98b7-50de70ef9d22",
      "name": "Startups & Venture",
      "order": 0
    }
  ],
  "calendars": [
    {
      "id": "cal-abc123",
      "name": "Founder Dinners",
      "slug": "founder-dinners",
      "source": "api",
      "kind": "calendar",
      "provider": "luma",
      "ownership": "connected",
      "isDefault": true,
      "url": "https://lu.ma/founder-dinners",
      "avatarUrl": "https://images.lumacdn.com/calendars/founders.png",
      "coverUrl": "https://images.lumacdn.com/calendar-cover-images/founders.jpg",
      "description": "Founder events and community dinners.",
      "color": "#ff6600",
      "eventCount": 42,
      "hasEvents": true,
      "order": 0,
      "group": {
        "id": "b53ea106-79d1-45fe-98b7-50de70ef9d22",
        "name": "Startups & Venture",
        "order": 0
      },
      "curatedName": "Founder Dinners",
      "remoteName": "Founder Dinners",
      "suggestedGroup": null,
      "sync": {
        "status": "completed",
        "error": null,
        "discovered": 42,
        "imported": 42,
        "lastSyncedAt": "2026-07-28T13:00:00.000Z",
        "lastAttemptedAt": "2026-07-28T13:00:00.000Z",
        "historicalSyncCompletedAt": "2026-07-27T13:00:00.000Z",
        "scope": "maintenance",
        "nextSyncAt": "2026-07-29T13:00:00.000Z"
      }
    },
    {
      "id": "scr-xyz789",
      "canonicalCalendarId": "cal-xyz789",
      "aliases": ["scr-cal-xyz789", "https://luma.com/example"],
      "name": "Imported events",
      "slug": null,
      "source": "scrape",
      "isDefault": false,
      "url": "https://lu.ma/example"
    }
  ]
}
```

Calendar fields:

| Field                 | Type                                          | Notes                                                                                         |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `id`                  | `string`                                      | Pass this as `calendar` to `/api/v1/events`.                                                  |
| `canonicalCalendarId` | `string \| null`                              | Stable Luma `cal-*` identity when it has been resolved.                                       |
| `aliases`             | `string[]`                                    | Permanent legacy IDs, URLs, and slugs accepted anywhere a calendar ID is used.                |
| `name`                | `string \| null`                              | Display name from Luma or the imported calendar.                                              |
| `slug`                | `string \| null`                              | Luma slug when available.                                                                     |
| `source`              | `"api" \| "scrape"`                           | `api` is a connected provider/API calendar; `scrape` is an imported public calendar.          |
| `kind` / `sourceKind` | `"api" \| "calendar" \| "profile" \| "event"` | The logical source type (`sourceKind` is the explicit canonical field).                       |
| `provider`            | `"luma" \| "eventbrite" \| "meetup"`          | Remote event provider.                                                                        |
| `ownership`           | `"connected" \| "external"`                   | Whether the source comes from an authorized organizer connection.                             |
| `isMine`              | `boolean`                                     | Whether the user marked this calendar as their own. Filter the list with `?mine=true\|false`. |
| `isDefault`           | `boolean`                                     | User's default calendar in this app.                                                          |
| `url`                 | `string \| null`                              | Calendar URL when known.                                                                      |
| `avatarUrl`           | `string \| null`                              | Calendar/profile logo with media fallbacks applied.                                           |
| `coverUrl`            | `string \| null`                              | Calendar cover or social image.                                                               |
| `description`         | `string \| null`                              | Latest public description.                                                                    |
| `color`               | `string \| null`                              | Luma tint color when available.                                                               |
| `eventCount`          | `number`                                      | Number of imported events currently stored.                                                   |
| `upcomingCount`       | `number`                                      | Upcoming and currently ongoing canonical events for this calendar.                            |
| `pastCount`           | `number`                                      | Canonical events that have already ended or started without an end time.                      |
| `unknownCount`        | `number`                                      | Canonical events without a usable start timestamp.                                            |
| `hasEvents`           | `boolean`                                     | Convenience flag derived from `eventCount`.                                                   |
| `group`               | `object \| null`                              | User-defined group and its display order.                                                     |
| `order`               | `number`                                      | Calendar order inside its group.                                                              |
| `curatedName`         | `string \| null`                              | User-controlled display label, preserved across syncs.                                        |
| `remoteName`          | `string \| null`                              | Latest name reported by Luma.                                                                 |
| `suggestedGroup`      | `object \| null`                              | Deterministic grouping suggestion awaiting approval.                                          |
| `providerSourceId`    | `string \| null`                              | Provider-specific source/group identifier when available.                                     |
| `sync`                | `object`                                      | Status, counts, last successful/attempted timestamps, scope, and historical completion.       |

Sync status is one of `idle`, `queued`, `running`, `completed`, `partial`,
`failed`, or `inaccessible`. A `partial` source used a fallback but could not
confirm every event. Calendars confirmed to have no published events remain in
the collection with `hasEvents: false`.

### `GET /api/v1/events`

Returns routed events for the caller. By default it reads all connected
calendars, merges API-backed and imported calendars, and returns one canonical
event with every source where it appeared.

Query parameters:

| Param      | Type                                  | Default     | Notes                                                                                                            |
| ---------- | ------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `calendar` | `string`                              | `all`       | Use `all`, omit it, or pass a current `id`, `canonicalCalendarId`, or any alias returned by `/api/v1/calendars`. |
| `provider` | `luma \| eventbrite \| meetup`        | —           | Restrict results to one provider.                                                                                |
| `owned`    | `true \| false`                       | —           | Restrict results by authorized organizer ownership.                                                              |
| `mine`     | `true \| false`                       | —           | Restrict results to calendars the user marked as their own (`true`) or not (`false`).                            |
| `mode`     | `canonical \| sources`                | `canonical` | `canonical` returns unique events with `sources`; `sources` returns one row per source/calendar sighting.        |
| `status`   | `all \| upcoming \| ongoing \| past`  | `all`       | `upcoming` includes events currently in progress; use `ongoing` to return only those events.                     |
| `sort`     | `upcoming \| start_asc \| start_desc` | `upcoming`  | `upcoming` orders ongoing events first, future events nearest-first, then past events newest-first.              |
| `at`       | ISO date string                       | server time | Reference instant for status/order. Reuse the first response's `generatedAt` on later pages.                     |
| `from`     | ISO date string                       | none        | Inclusive lower bound on `startAt`.                                                                              |
| `to`       | ISO date string                       | none        | Inclusive upper bound on `startAt`.                                                                              |
| `limit`    | integer `1..200`                      | `100`       | Page size.                                                                                                       |
| `cursor`   | opaque string                         | none        | `page.nextCursor` from the previous response.                                                                    |

Example:

```bash
curl -H "Authorization: Bearer luma_sk_..." \
  "https://your-event-aggregator.example/api/v1/events?calendar=all&from=2026-07-01T00:00:00Z&limit=25"
```

Response:

```json
{
  "events": [
    {
      "id": "evt-abc123",
      "name": "AI Builders Night",
      "coverUrl": "https://images.lu.ma/example.jpg",
      "url": "https://lu.ma/ai-builders-night",
      "startAt": "2026-07-31T23:00:00.000Z",
      "endAt": "2026-08-01T02:00:00.000Z",
      "temporalStatus": "upcoming",
      "durationMinutes": 180,
      "city": "Lima, Peru",
      "description": "A meetup for builders.",
      "externalIds": {
        "lumaEventId": "evt-abc123",
        "scrapedEventKeys": []
      },
      "sources": [
        {
          "sourceType": "api",
          "sourceKey": "api:cal-abc123:evt-abc123",
          "calendarId": "cal-abc123",
          "calendarName": "Founder Dinners",
          "sourceUrl": "https://lu.ma/ai-builders-night",
          "externalEventId": "evt-abc123",
          "hostName": null,
          "lastSyncedAt": "2026-07-28T14:00:00.000Z"
        }
      ],
      "sourceCount": 1,
      "sourceCalendars": [
        {
          "calendarId": "cal-abc123",
          "name": "Founder Dinners",
          "slug": "founder-dinners",
          "source": "api"
        }
      ],
      "tags": [],
      "suggestedTags": [],
      "calendar": {
        "calendarId": "cal-abc123",
        "name": "Founder Dinners",
        "slug": "founder-dinners",
        "source": "api"
      }
    }
  ],
  "page": {
    "limit": 25,
    "offset": 0,
    "total": 88,
    "nextCursor": "MjU"
  },
  "mode": "canonical",
  "filters": {
    "calendar": "all",
    "status": "all",
    "at": null,
    "from": null,
    "to": null
  },
  "sort": "upcoming",
  "generatedAt": "2026-07-28T14:00:00.000Z"
}
```

Event fields:

| Field             | Type                                     | Notes                                                                            |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `id`              | `string`                                 | Luma event id, or `scr-*` for imported public events.                            |
| `name`            | `string`                                 | Event name.                                                                      |
| `coverUrl`        | `string \| null`                         | Cover image URL when available.                                                  |
| `url`             | `string`                                 | Public event URL.                                                                |
| `startAt`         | `string`                                 | ISO date string.                                                                 |
| `endAt`           | `string \| null`                         | ISO date string when known.                                                      |
| `temporalStatus`  | `upcoming \| ongoing \| past \| unknown` | Status calculated against the response's `generatedAt` instant.                  |
| `durationMinutes` | `number \| null`                         | Event duration when both timestamps form a valid interval.                       |
| `city`            | `string \| null`                         | Human-readable city/location when available.                                     |
| `description`     | `string \| null`                         | Markdown/text description when available.                                        |
| `externalIds`     | `object \| null`                         | Canonical mode only: known provider and scraped IDs.                             |
| `sources`         | `array \| null`                          | Canonical mode only: calendars/imports/profile sources where the event appeared. |
| `sourceCount`     | `number`                                 | Number of distinct source sightings merged into this event.                      |
| `sourceCalendars` | `array`                                  | Every known calendar containing the event, without duplicates.                   |
| `tags`            | `string[]`                               | Active labels from the controlled format/topic/audience taxonomy.                |
| `suggestedTags`   | `string[]`                               | Lower-confidence system labels awaiting confirmation.                            |
| `tagDetails`      | `object[]`                               | Label namespace, origin, confidence, state, and taxonomy version.                |
| `calendar`        | `object \| null`                         | Source calendar metadata.                                                        |

Use `mode=sources` when your integration needs one row per calendar/source
instead of deduplicated canonical events.

Pagination:

```ts
let cursor: string | null = null;
const allEvents: EventDTO[] = [];

do {
  const qs = new URLSearchParams({ calendar: "all", limit: "100" });
  if (cursor) qs.set("cursor", cursor);

  const page = await eventAggregatorFetch<EventsResponse>(`/api/v1/events?${qs}`);
  allEvents.push(...page.events);
  cursor = page.page.nextCursor;
} while (cursor);
```

Treat cursors as opaque. Do not decode or construct them in your app.

## Dates And Ordering

All timestamps are ISO 8601 instants. The server calculates `temporalStatus`
using both `startAt` and `endAt` against `generatedAt`, so an event that already
started but has not ended is `ongoing`, not `past`.

Use `status=upcoming&sort=upcoming` for a discovery feed. This includes ongoing
events first, followed by future events from nearest to farthest. Use
`status=past&sort=start_desc` for history.

For multipage reads, send the first page's `generatedAt` back as `at` on every
later request. This freezes temporal classification and ordering while the
consumer traverses the collection.

## Errors

Error responses are JSON:

```json
{ "error": "invalid_token" }
```

| HTTP  | `error`         | Meaning                                                    |
| ----- | --------------- | ---------------------------------------------------------- |
| `401` | `missing_token` | No `Authorization` header was sent.                        |
| `401` | `invalid_token` | Token is malformed, unknown, or revoked.                   |
| `400` | `bad_params`    | Invalid query parameter, such as a bad ISO date or cursor. |
| `500` | `server_error`  | Server-side failure while reading calendars/events.        |

All REST responses include permissive CORS headers and `cache-control: no-store`.

## MCP Router

The app also exposes an MCP server for OAuth-capable clients:

| Route                                   | Purpose                            |
| --------------------------------------- | ---------------------------------- |
| `/mcp`                                  | Main MCP endpoint.                 |
| `/.mcp/list-tools`                      | Lists available MCP tools.         |
| `/.mcp/invoke-tool/:tool`               | Invokes one MCP tool.              |
| `/.well-known/oauth-protected-resource` | OAuth protected-resource metadata. |

Current tools:

| Tool             | Purpose                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `whoami`         | Verify the authenticated user id and email.                                                |
| `list_calendars` | List connected and imported calendars (`mine` filter).                                     |
| `list_events`    | Consolidated events; filters `mine`, `calendar_id`, `status`, `q`, `from`, `to`; `cursor`. |
| `get_event`      | One event with description, venue, tags and all its sources.                               |

### MCP with API token

MCP also accepts the same read-only `luma_sk_` Bearer tokens as REST. OAuth is
unchanged. Send the token to the published MCP endpoint:

```bash
curl -sS -X POST "https://eventrouter.lovable.app/mcp" \
  -H "Authorization: Bearer luma_sk_REDACTED" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

Token scopes:

| Tool             | Required scope   |
| ---------------- | ---------------- |
| `whoami`         | none             |
| `list_calendars` | `calendars:read` |
| `list_events`    | `events:read`    |
| `get_event`      | `events:read`    |

The token path is read-only. A missing scope returns a tool error
`insufficient_scope: <scope>`. `whoami` returns `{ user_id, auth: "api_token", scopes }`
and never echoes the token.

Use the REST API for ordinary app integrations. Use MCP when the consumer is an
agent/client that already speaks MCP. Prefer a `luma_sk_` token when the client
cannot complete the Supabase OAuth flow.

## Get one canonical event

`GET /api/v1/events/{canonicalId}` returns the current canonical representation
for one event. The endpoint uses the same Bearer token and `events:read` scope
as the collection endpoint. Use the `canonicalId` returned by
`GET /api/v1/events?mode=canonical` rather than a provider-specific event ID.

```bash
curl \
  -H "Authorization: Bearer luma_sk_..." \
  "https://your-event-aggregator.example/api/v1/events/00000000-0000-0000-0000-000000000001"
```

## TypeScript Types

```ts
type CalendarSource = "api" | "scrape";
type EventProvider = "luma" | "eventbrite" | "meetup";

type CalendarGroupDTO = {
  id: string;
  name: string;
  order: number;
};

type CalendarDTO = {
  id: string;
  canonicalCalendarId: string | null;
  aliases: string[];
  name: string | null;
  slug: string | null;
  source: CalendarSource;
  sourceKind: "api" | "calendar" | "profile" | "event";
  provider: EventProvider;
  ownership: "connected" | "external";
  isDefault: boolean;
  url: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  description: string | null;
  color: string | null;
  eventCount: number;
  upcomingCount: number;
  pastCount: number;
  unknownCount: number;
  hasEvents: boolean;
  group: CalendarGroupDTO | null;
  order: number;
  providerSourceId: string | null;
};

type EventCalendarDTO = {
  calendarId: string;
  name: string;
  slug: string | null;
  source: CalendarSource;
  provider: EventProvider;
  ownership: "connected" | "external";
};

type EventSourceDTO = {
  provider: EventProvider;
  sourceType:
    | "api"
    | "calendar_scrape"
    | "event_scrape"
    | "profile_scrape"
    | "eventbrite_api"
    | "eventbrite_public"
    | "meetup_api"
    | "meetup_public";
  sourceKey: string;
  calendarId: string | null;
  calendarName: string | null;
  sourceUrl: string;
  externalEventId: string | null;
  hostName: string | null;
  lastSyncedAt: string;
};

type EventDTO = {
  id: string;
  canonicalId: string | null;
  name: string;
  coverUrl: string | null;
  url: string;
  startAt: string;
  endAt: string | null;
  temporalStatus: "upcoming" | "ongoing" | "past" | "unknown";
  durationMinutes: number | null;
  city: string | null;
  description: string | null;
  timezone: string | null;
  updatedAt: string | null;
  enrichment: {
    languageCode: string | null;
    languages: string[];
    countryCode: string | null;
    region: string | null;
    venueName: string | null;
    venueAddress: string | null;
    isOnline: boolean | null;
    format: string | null;
    topics: string[];
    audience: string[];
    level: string | null;
    organizer: string | null;
    confidence: number | null;
  };
  externalIds: {
    lumaEventId?: string;
    eventbriteEventId?: string;
    meetupEventId?: string;
    scrapedEventKeys: string[];
  } | null;
  sources: EventSourceDTO[] | null;
  sourceCount: number;
  sourceCalendars: EventCalendarDTO[];
  tags: string[];
  suggestedTags: string[];
  tagDetails: Array<{
    namespace: "format" | "topic" | "audience";
    slug: string;
    label: string;
    origin: "system" | "manual";
    state: "active" | "dismissed";
    confidence: number | null;
    taxonomyVersion: number;
  }>;
  calendar: EventCalendarDTO | null;
};

type CalendarsResponse = {
  groups: CalendarGroupDTO[];
  calendars: CalendarDTO[];
};

type EventsResponse = {
  events: EventDTO[];
  page: {
    limit: number;
    offset: number;
    total: number;
    nextCursor: string | null;
  };
  mode: "canonical" | "sources";
  filters: {
    calendar: string;
    provider: "luma" | "eventbrite" | "meetup" | null;
    owned: "true" | "false" | null;
    mine: "true" | "false" | null;
    q: string | null;
    country: string | null;
    city: string | null;
    language: string | null;
    online: "true" | "false" | null;
    format: string | null;
    topic: string | null;
    status: "all" | "upcoming" | "ongoing" | "past";
    at: string | null;
    from: string | null;
    to: string | null;
  };
  sort: "upcoming" | "start_asc" | "start_desc";
  generatedAt: string;
};

## Incremental indexing

Use `GET /api/v1/changes?since=0&limit=500` (alias:
`GET /api/v1/events/changes?since=0&limit=500`) for the first historical
load and persist `nextCursor`. Subsequent requests return only canonical event
upserts and delete tombstones. Apply upserts by `canonicalId` and remove IDs
listed in `deletes`; never insert changes blindly more than once. The short
path is the one clients should call; both routes share the same handler.

The enriched event response includes normalized location, language, online or
in-person mode, format, topics, audience, organizer, confidence, and field
provenance when available. See [openapi.yaml](./openapi.yaml) for the machine-
readable contract.
```
