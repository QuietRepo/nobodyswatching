# NobodysWatching.live

**Where small streamers get seen.**

A free discovery directory for small streamers. No algorithm. No follower requirements. No data harvesting. Just a place where every streamer gets listed equally.

🔗 **[nobodyswatching.live](https://nobodyswatching.live)**

*The name's ironic. We hope.*

---

## What is this?

NobodysWatching.live is a streamer directory built for the people Twitch's algorithm forgot. Sign in, build a profile, link your channels, and you're listed alongside everyone else - regardless of follower count or viewer numbers.

When you go live on Twitch, Kick, or YouTube, the site detects it automatically and puts you in the Live Now carousel. Viewers can browse by genre, timezone, or language, hit the Random Streamer button, or use the Raid Finder to get pointed at someone worth checking out.

## Features

- **Equal listing** — every streamer appears the same, no sorting by popularity
- **Multi-platform live detection** — Twitch and YouTube checked every 3 minutes; a streamer can be tracked as live on more than one platform at once, with a preferred-platform setting for which gets top billing. Kick is a fully supported profile link but live detection is disabled (their API blocks it)
- **Sign in with Twitch or Google** — one click, no forms, no email collection
- **Streamer profiles** — bio, genres, vibes, top games, timezone, language, shareable profile pages
- **Six platform links** — Twitch, YouTube, Kick, Rumble, TikTok, Velora
- **Genre, timezone & language filtering** — find streamers who play what you like, when you're awake, in the language you want
- **"Playing Now" chips** — a glance-strip of every game currently being streamed on the site, click to filter and jump straight to results
- **Spotlight** — the lowest-viewer genuinely-live streamer gets homepage priority every poll, not the biggest one
- **Raid Finder** — pick a genre/vibe (or "any"), get a suggestion weighted toward the smallest streamers, preview them first, then get the copyable raid command
- **Recommended channels** — a streamer viewing their own public profile page sees 3 others matched on genre/top games, picked at random, never sorted by size — with a "go get 'em" callout if one happens to be live. Not shown to their audience, just a discovery nudge for the streamer themselves
- **Random Streamer button** — discover someone new by pure chance
- **Achievements** — private, participation-only badges (profile setup, going live, linking platforms, using the discovery features) visible only to the streamer themselves, never tied to popularity
- **Outbound click counting** — anonymous, aggregate-only tracking of clicks from the site to a streamer's actual channel, so the site can eventually say whether it's doing anything rather than just hoping. No visitor data of any kind — see Privacy below
- **Message of the Day** — dismissible, auto-expiring site-wide announcements
- **Discord "who's live" announcer** — posts one live streamer every 30 minutes to the community Discord, bounded and predictable rather than event-spammy
- **Profile visibility controls** — a manual, reversible full-hide for bad-actor accounts, filtered at the database level, distinct from the Spotlight-only exemption used for AFK/rerun edge cases
- **Badge system** — Founder, Tester, OG, Supporter badges for early adopters
- **Streamer Pack** — downloadable Twitch panel image and copy-paste promo text
- **Auto-scrolling live carousel** — with mouse drag and touch swipe support
- **Mobile responsive** — works on everything from phones to ultrawide monitors

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Vanilla HTML / CSS / JS |
| Hosting | Netlify (credit-based plan) |
| Database | Supabase (Pro tier) |
| Auth | Twitch OAuth + Google OAuth via Supabase |
| Live Detection | Netlify Scheduled Function (every 3 min) |
| APIs | Twitch Helix, YouTube InnerTube (unofficial, quota-free) + Data API v3 for viewer counts |
| Domain | IONOS (~£4.50/year) |

No frameworks. No build step. No bloat. Push to GitHub, Netlify deploys automatically.

## Project Structure

```
nobodyswatching-site/
├── netlify.toml                        # Netlify config (publish=public)
├── package.json                        # @supabase/supabase-js dependency
├── CHANGELOG.md                        # Release history
├── nobodyswatching-design-system.md    # Brand voice, colour, typography reference
├── public/
│   ├── index.html                      # Homepage, directory, live carousel, Raid Finder, Spotlight
│   ├── profile.html                    # Profile editor, private achievements
│   ├── streamer.html                   # Public streamer profile page
│   ├── about.html                      # About + Streamer Pack
│   ├── privacy.html                    # Privacy policy
│   ├── favicon.svg                     # Site favicon
│   └── twitch-panel.png               # Downloadable Twitch panel image
└── netlify/functions/
    ├── check-live-status.mjs           # Multi-platform live polling, achievement triggers, Spotlight selection
    ├── announce-live-streamer.mjs      # Discord "who's live" announcer (every 30 min)
    ├── award-achievement.mjs           # Authenticated endpoint for client-triggered achievements
    ├── track-click.mjs                 # Unauthenticated outbound-click counter, aggregate only
    └── lib/
        └── achievements.mjs            # Shared achievement-catalog + award helpers
```

## How It Works

1. User signs in via Twitch or Google OAuth (handled by Supabase)
2. A profile row is auto-created in Supabase with their username and avatar
3. User fills out their profile: bio, timezone, language, genres, vibes, top games, platform links
4. A scheduled Netlify function runs every 3 minutes:
   - Fetches all visible profiles with linked streaming platforms
   - Checks Twitch API and YouTube (InnerTube) for live status
   - Updates `is_live`, `live_game`, `live_viewer_count`, `live_thumbnail_url`, `live_platform`, and `live_platforms`
   - Increments `times_live` on offline -> live transitions and awards the relevant achievements (First stream, Regular, Multi-streaming)
   - Computes the Spotlight winner and awards In the Spotlight
5. The homepage queries Supabase and renders the live carousel, directory grid, Playing Now chips, and Spotlight
6. Achievements the client can only self-report (Used Raid Finder, Feeling lucky, Playing the field) are sent to a small server function, which re-verifies anything checkable before writing
7. Every exit link on the site (carousel/spotlight/directory pills, streamer page platform links, Watch Now, Also Live, Raid preview) fires an anonymous click to `track-click.mjs` via `sendBeacon` on click — never blocking the link's own navigation
8. Everything is client-side — no server rendering, no build step, aside from the scheduled functions and the achievement/click endpoints

## Privacy

We take a minimal approach to data:

- **Stored:** username, avatar URL, bio, timezone, genres, games, platform links, live status
- **Not stored, ever:** email, real name, location, IP address, or anything that identifies *you* as a visitor — no session, no cookie tracking you across the site, no record of which profiles you looked at or when
- **Stored, but not about you:** an anonymous count of clicks from the site to a streamer's channel — bucketed by profile, surface, platform, and day. It answers "did anyone click through to this streamer," never "who clicked." Full breakdown in [CHANGELOG.md](./CHANGELOG.md)
- **No analytics:** no Google Analytics, no Facebook Pixel, no cookies beyond auth. The click counter above is the one exception, and it's about the destination, not the visitor
- **Full policy:** [nobodyswatching.live/privacy.html](https://nobodyswatching.live/privacy.html)

## Local Development

If you want to run this locally:

1. Clone the repo
2. `npm install`
3. Set up a Supabase project and create the `profiles` table (see schema below)
4. Add your Supabase URL and anon key to the frontend JS
5. Set environment variables for the scheduled/server functions:
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `YOUTUBE_API_KEY` (optional — viewer counts and handle resolution only, live detection itself doesn't need it)
   - `DISCORD_LIVE_WEBHOOK_URL` (optional, for the Discord announcer)
6. `npx netlify dev` to run locally

## Database Schema

The `profiles` table in Supabase:

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | FK to auth.users |
| username | TEXT | Display name |
| avatar_url | TEXT | Profile picture URL |
| bio | TEXT | Max 250 chars |
| timezone | TEXT | e.g. "UTC+00:00" |
| language | TEXT | Streamer's preferred language |
| genres | TEXT[] | Array of genre tags |
| vibes | TEXT[] | Self-declared atmosphere tags, powers Raid Finder matching |
| top_games | TEXT[] | Up to 5 games |
| twitch_username | TEXT | Extracted from Twitch OAuth |
| twitch_url, youtube_url, kick_url, rumble_url, tiktok_url, velora_url | TEXT | Platform links |
| youtube_channel_id | TEXT | Resolved once, cached, avoids re-resolving on every poll |
| preferred_platform | TEXT | Which platform gets top billing when multi-streaming |
| is_live | BOOLEAN | Updated by scheduled function |
| is_rerun | BOOLEAN | Twitch-API-detected rerun/VOD, excluded from Spotlight but still shown in the carousel |
| spotlight_exempt | BOOLEAN | Manual Spotlight-only exclusion (AFK streams, self-run loops) |
| is_visible | BOOLEAN | Full hide for bad actors, filtered at the query level |
| hidden_at, hidden_reason | TIMESTAMP, TEXT | Audit trail for `is_visible`, fully reversible |
| live_game | TEXT | Current game/title when live |
| live_viewer_count | INTEGER | Current viewer count |
| live_thumbnail_url | TEXT | Stream thumbnail |
| live_platform | TEXT | Primary platform they're live on |
| live_platforms | TEXT[] | Every platform they're currently live on at once |
| youtube_live_video_url | TEXT | Direct watch URL for the current YouTube live video |
| last_live_at | TIMESTAMP | Last time they were detected live |
| times_live | INTEGER | Running count of offline -> live transitions, powers the Regular achievement |
| badges | TEXT[] | e.g. {"Founder", "OG"} |
| has_seen_discord_nudge | BOOLEAN | One-time Discord invite nudge, tracked per-account |
| created_at, updated_at | TIMESTAMP | Auto-set / auto-updated |

Also: `site_messages` (Message of the Day), `discord_announcements` (who's-live announcer history), `achievements` (achievement catalog), `profile_achievements` (which streamer has earned what, when), and `outbound_clicks` (anonymous outbound click counts — profile, surface, platform, and UTC day, nothing else — rolled up from daily to monthly after six months, never deleted).

RLS is enabled throughout: public read where the data is meant to be public (profiles, active messages, the achievement catalog), owner-only read for private data (a streamer's own earned achievements), and all writes go through the service role from scheduled functions or verified endpoints — never directly from the client. `outbound_clicks` goes a step further: zero read policies at all, not even for the streamer it's about, since the only thing that table will ever surface is a future private achievement, never a visible number. A database trigger auto-creates a profile row on first sign-in.

## Contributing

This is a solo project but feedback is welcome. If you find a bug or have a feature idea:

- Open an issue on this repo
- Drop into the [Discord](https://discord.gg/MxD634NBsn)
- Message me on [Twitch](https://twitch.tv/x_taptap_x) or [Bluesky](https://bsky.app/profile/xtaptapx.bsky.social)

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full release history.

## Licence

This project is open source. Built by a small streamer, for small streamers.

---

*Built by [x_TapTap_x](https://twitch.tv/x_taptap_x) — 56 years old, still rushing B, still getting bodied.*
