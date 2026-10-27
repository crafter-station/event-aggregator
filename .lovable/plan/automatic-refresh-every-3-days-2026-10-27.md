# Automatic refresh every 3 days

## What you get
- Every 3 days, the app re-reads every calendar and event added for all accounts:
  - Calendars and single events imported by link (Luma pages and Meetup), using the web reader.
  - Calendars connected with a Luma key, using that account's own key.
- Each calendar keeps its last refresh date and any error. Settings shows both next to each calendar, plus a line such as "Auto-refresh every 3 days · last run 2 days ago".
- When a calendar fails 3 times in a row, it is skipped until someone refreshes it by hand. This keeps web-reader credits from being wasted on broken links.

## How it works
1. **Scheduled trigger:** a timer in the backend calls a private refresh address every 3 days at 06:00 UTC, which is 01:00 Lima time.
2. **Refresh job:** it goes through the calendars in small batches and reuses the same sync logic that the "refresh" button and link import already use. Duplicate detection and event counts stay consistent.
3. **Safety:** the job only runs when the call includes a server-only secret, so visitors can't trigger it and spend credits. Running it twice in a row does no harm.

## Technical details
- New server route `src/routes/api/public/hooks/refresh-sources.ts` (POST). It requires the `Authorization: Bearer <CRON_SECRET>` header, using a new generated secret that is compared in a timing-safe way. It loads the backend admin client inside the handler.
- New module `src/lib/scheduled-refresh.server.ts`:
  - Selects `user_luma_calendars` rows where `merged_into_id` is null and consecutive failures are below 3.
  - Sends Luma API calendars through the existing per-user sync, using the decrypted key, and scraped or Meetup sources through the existing `luma-scrape` / Meetup import paths.
  - Runs about 3 calendars at a time and stops early near the time budget. The rest are picked up on the next run because the oldest `last_synced_at` goes first.
- Migration: add `auto_sync_failures int default 0`, `last_auto_sync_at timestamptz` and `last_auto_sync_error text` to `user_luma_calendars`, if the existing sync-tracking columns don't already cover them. Columns that already exist get reused.
- Schedule with `pg_cron` + `pg_net`, `0 6 */3 * *`, posting `{}` to `https://project--47158c08-59a5-4081-b25e-b7797ebe8224.lovable.app/api/public/hooks/refresh-sources`. This SQL is applied once and is not stored in a migration.
- Settings UI: show the last auto-refresh time and error for each calendar.
- Tests for the eligibility rule (skip after 3 failures; oldest goes first).
- The schedule calls the published app, so you need to republish once for it to take effect.
