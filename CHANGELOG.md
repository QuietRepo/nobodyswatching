# Changelog

All notable changes to NobodysWatching.live are documented here.

---
[2026-09-14] - MONTHLY CLICK DIGEST

### Added
- A private "last month" card on a streamer's own profile page — a one-off total of how many times their links got clicked, shown at most once a calendar month
- Straight out of Discord feedback on the click-counting change: a few people asked whether streamers could see their own numbers privately, since the whole thing started from a poll nobody could actually answer. Fair ask, and a narrower one than what we'd deliberately ruled out (no public numbers, no leaderboard), so here it is
- `get-click-digest.mjs` — authenticated endpoint, same verify-then-act pattern as the achievement endpoint. Returns only the caller's own previous-month total, nothing else, ever
- `get_previous_month_clicks()` — new SQL function alongside the other three, sums a profile's clicks for the prior complete calendar month only
- `last_click_digest_month` column on `profiles`, tracking which month's digest a streamer's already seen — same idea as the one-time Discord nudge flag, but recurring

### Notes
- Silent on zero. A streamer who got no clicks last month sees nothing at all — no card, no "0 clicks." A visible zero reads as a verdict; absence just reads as nothing having happened yet
- Not a dashboard. There's no page to go check this number whenever you like — it shows up once, you dismiss it, it's gone until next month produces something worth saying
- `outbound_clicks` is still completely locked at the table level — zero read policies, same as before. This doesn't change that; it adds one more narrow, purpose-built function that reads it server-side and returns only what the caller is entitled to see, same shape as the achievement sweep already does
- privacy.html and README.md both needed a real correction here, not just an addition — both previously stated flatly that no number is ever shown to anyone. That's no longer true, and pretending otherwise in the privacy policy would've been worse than the thing we were trying to avoid in the first place. Both now describe the digest honestly
- Straightforward to test with real traffic once a full month's gone by. Harder to verify on demand without hand-seeding `outbound_clicks` rows dated last month — worth keeping in mind if this doesn't show up immediately after deploy

---
[2026-09-14] - OUTBOUND CLICK TRACKING (Private, Aggregate Only)

### Added
- A private counter for how many people click through from the site to a streamer's actual channel — the thing "did NWL help you?" was trying and failing to measure with a Discord poll last week (0 votes in 24 hours, if you're wondering what prompted this)
- Every genuine exit link now reports a click: the live carousel, spotlight card, and directory grid pills, the "Also live on" band and platform links on individual streamer pages, the main Watch Now button, and the Raid Finder's "Check them out first" button
- New `outbound_clicks` table, bucketed by profile + surface + platform + UTC day. A click doesn't create a row, it increments one — ten clicks on the same link on the same day is one row reading 10, not ten rows
- `record_outbound_click()` — the only way anything gets written, called from a new unauthenticated Netlify function (`track-click.mjs`) via `navigator.sendBeacon`, so a click never delays or interferes with the link's own navigation
- `rollup_outbound_clicks()` — day-level detail collapses into monthly totals after six months. Nothing is ever deleted, just made coarser, so year-on-year comparisons stay possible indefinitely. Scheduled via `pg_cron`, not yet turned on since nothing's six months old yet

### Fixed
- Live testing right after deploy found zero rows landing anywhere — the carousel, spotlight, and directory pills all sit inside clickable cards and already carry `onclick="event.stopPropagation()"` (so clicking a pill doesn't also trigger the card's own navigation to the profile page). That stops the click from bubbling any further, which silently stopped it from ever reaching the tracking listener too, since it was listening the normal way. Fixed by listening on the capture phase instead — runs on the way down to the pill, before its own `onclick` gets the chance to cut the event off. `streamer.html`'s links never had this problem, since nothing there calls `stopPropagation()`
- Confirmed working end to end afterwards: directory, spotlight, and carousel pills all landing rows correctly

### Notes
- This is not analytics. There's no visitor identity, no session, no IP, no ordering of events — a row says "this profile's Twitch link was clicked 4 times on the 14th," full stop. You could not reconstruct one visitor's path through the site from this table if you tried
- `outbound_clicks` has Row Level Security on and zero policies — not even the streamer it's about can read it. The only thing this data will ever surface is a future private achievement once a profile's links have been clicked a handful of times. No number is shown anywhere, to anyone, ever
- The "Playing Now" chip row was deliberately left out — clicking a chip filters the directory, it doesn't leave the site, so there's nothing to count
- Endpoint checks the request's Origin/Referer against the site's own domain before writing anything. Stops casual poking around, not a determined script — acceptable given the table has no public read access regardless, so the worst case is a slightly inflated internal number, not exposed data
- README.md's Privacy section has been updated to match. privacy.html still says the site does zero tracking of any kind — that's no longer quite true and still needs a short, honest update. Not done yet
- The achievement itself (something like "someone clicked through to you") isn't wired up yet — this ships the counting, not the payoff

---
[2026-09-12] - SHARE CARDS (OPEN GRAPH)

### Fixed
- Every shared profile link has been unfurling as a blank grey box titled "Streamer Profile" since launch. streamer.html had no Open Graph tags at all, so Discord, Bluesky, X and everything else had nothing to show. Several hundred streamers have been advertising the site with an advert that renders as nothing
index.html had OG tags but no og:image, and its Twitter card was set to summary rather than summary_large_image, so the homepage link had no picture either

- The share block sat flush against the Save and Back to Home buttons. .form-actions has a top border and padding but no bottom margin, so the new block needed its own margin-top. Now matches .danger-zone at 2.5rem so the three blocks below the form line up

### Added
og-card.png, a proper 1200x630 share card in the site palette
netlify/edge-functions/profile-meta.js, which rewrites the head of /streamer.html per profile. Checks the user agent first and returns immediately for real people, so only crawlers and link unfurlers trigger the Supabase lookup. Mirrors streamer.html's own query exactly, ilike on username plus is_visible, so hidden profiles get no card
Static fallback OG tags on streamer.html for when the edge function does not run. Branded rather than personal, but never blank again

### Changed
Someone who is live gets their stream thumbnail as the share image instead of their avatar, so sharing a live profile shows what they are actually playing. Offline profiles use their avatar as a square card, no avatar falls back to the site card

---
[2026-09-04] - KICK LIVE DETECTION RESTORED

### Fixed
Kick live detection is back. Turns out "revisit if Kick ever ships an official API" wasn't wishful thinking, it was foreshadowing — they shipped one, and it actually works
Kick-only streamers were never showing as live, even while very much live, since launch. Sorry to anyone who spent months looking offline

### Changed
checkKickLive() rebuilt from scratch on Kick's new official Public API (api.kick.com) instead of the old approach that got blocked by their bot protection. Uses an app access token via client_credentials, same pattern as the Twitch check
Kick usernames are resolved to numeric broadcaster IDs once and cached, instead of re-resolving on every 3-minute poll — the same caching trick already used for YouTube channel IDs, because we've apparently got a type

### Added
kick_broadcaster_id column on profiles, populated automatically the first time a Kick-linked profile gets checked

---
[2026-08-25] — Discord Announcer: Second Fairness Fix (Determinism)

### Fixed
- The overdue-rotation fix from earlier today still had a flaw: it picked *randomly* from the top 5 most-overdue candidates. That's fine with plenty of people live, but during quiet hours with only 2-3 people live total, that "top 5" pool ends up being basically everyone live — including whoever was *just* announced. Pure chance could then pick them again almost immediately. Confirmed in production: one streamer was announced at 6am, 9am, and 10am.

### Changed
- Selection is now **fully deterministic** — always picks the single most-overdue eligible person, no randomness at all. Guarantees fair rotation regardless of how many (or how few) people happen to be live at any given moment.
- Tested directly against the exact scenario that caused the bug (a 2-person pool, one just announced 5 minutes prior) — 0 incorrect picks across 1,000 simulated runs, confirming the fix eliminates the issue rather than just reducing its likelihood.

### Notes
- The "little spontaneity" argument for randomness turned out not to matter in practice — nobody watching the channel can tell strict rotation apart from "random from a small pool" anyway, and true fairness is worth more than an imperceptible nuance that was actively causing the bug.

---

[2026-08-24] — Discord "Who's Live" Announcer: Fair Rotation Fix
## Fixed
 - The Discord live announcer was selecting from the lowest-viewer 5 people live at any given moment — at 410 signups with 30+ concurrent streamers, this meant anyone above the smallest viewer tier could be permanently excluded from ever appearing, not by chance but structurally. It also meant a small streamer succeeding and growing their viewer count could quietly lose their spot in rotation — the opposite of what the feature is for.

## Changed
 - Selection now ranks everyone eligible by how long it's been since they were last announced, using the existing discord_announcements history. Never-announced counts as maximally overdue, so brand-new streamers going live for the first time aren't stuck behind everyone else's history.
 - Still picks randomly from the top handful of most-overdue candidates each cycle (not a rigid, fully predictable queue), keeping some spontaneity while guaranteeing fair rotation over time.
 - Removed the old separate "don't repeat the last person" check — it's now handled automatically, since whoever was just announced has the most recent timestamp and naturally ranks least-overdue.

## Notes
 - Everyone eligible now reliably surfaces eventually, regardless of viewer count — no one can be mathematically locked out of the rotation anymore.

---

### [2026-08-15] - UPDATES

## Added
 - Prev/next arrows on the live carousel - solid circular buttons on the left/right edges, always visible (not hover-reveal), because it turns out "drag the row with your mouse" wasn't exactly self-explanatory. Streamer-requested. Clicking pauses the auto-scroll the same way dragging already does, and resumes it a few seconds later
 - Arrows only show up when there's actually something to page through - hidden when the carousel content fits without overflowing (e.g. only 1-2 people live), recalculated on window resize. No dead buttons pointing nowhere
 - `aria-label`s on both buttons ("Previous streamer" / "Next streamer") for keyboard and screen reader users
 - Desktop/tablet only for now - mobile already has touch swipe, so arrows are hidden under 768px to avoid cluttering a screen that's already tight on space

## Fixed
 - The viewer-count filter chips (Any / Under 5 / Under 10 / Under 25) were re-rendering the carousel's card list without re-attaching the drag handlers, so dragging (and now the arrows) would silently stop working the moment someone used that filter. Re-binding now happens on every re-render, not just the initial page load

---

### [2026-08-13] - UPDATES (3)

## Added
 - Dynamic sitemap.xml, served via a Netlify function at /sitemap.xml (redirect in netlify.toml) rather than a static file, since the real value is every streamer's profile page getting indexed, not just the 3 static pages - profile URLs are database-driven, so there's no build step to bake them in ahead of time. Excludes profile.html (the signed-in owner's own edit form, not public content) and anything with is_visible: false, same rule as everywhere else on the site
 - robots.txt, pointing crawlers at the new sitemap

---

### [2026-08-13] - UPDATES (2)

## Added
 - Skeleton loaders on the homepage (live carousel + a fixed 6 on the directory grid, since the real count isn't known until the fetch resolves) and the streamer profile page. Static markup shown on first paint, no JS wiring needed beyond that - the existing render functions already overwrite it once real data arrives. Homepage previously showed nothing at all during the initial fetch; streamer page previously showed plain "// loading..." text

---

### [2026-08-13] - UPDATES

## Added
 - Carousel max-viewers filter - a chip row ("Any" / "Under 5" / "Under 10" / "Under 25") below the live carousel, letting viewers narrow it down to smaller channels themselves. A filter, not a sort - picking a threshold only removes profiles at or above it, it never reorders who's left, and it's off ("Any") by default same as every other filter on the site. Community-requested, with a deliberate design constraint: no option to sort ascending/descending by viewer count was added alongside it, since that would cross from "narrowing what's shown" into "ranking by popularity," which the site avoids on principle
 - Distinct empty-state copy when the viewer filter is just narrower than who's currently live (vs the existing "nobody's live at all" message), so it's clear the filter can be widened rather than reading like the site's broken

---

### [2026-08-11] - UPDATES (2)

## Added
 - Recommended channels - a "// you might also like" section at the bottom of a streamer's public profile page, showing 3 other streamers matched on genre and top games. Only visible to the streamer themselves when viewing their own page - not shown to their audience. Picked at random from whoever matches, never sorted or weighted by viewer count - same fairness rule as the Raid Finder and homepage Spotlight
 - Cascading match: tries genre + top-game overlap first, widens to genre-or-game if that pool's too small, and falls back to anyone visible as a last resort so the section isn't empty on a quiet day
 - A recommended streamer who happens to be live gets the same red avatar glow already used for the main profile avatar when live (`--live-red` / `--live-glow` - no new styling added), plus a "This legend is live right now, go get 'em, tiger" callout line; offline ones get a plain "worth a follow" line, same card treatment either way
 - Entirely client-side, read-only - no new tables, no server writes, just a query against data the page already has access to

---

### [2026-08-11] - UPDATES

## Added
 - Achievements - private, participation-only badges visible only to the streamer on their own profile, never shown publicly and never tied to viewer/follower counts (deliberately, to stay consistent with the no-ranking ethos). New `achievements` catalog table plus `profile_achievements` join table; writes only ever happen server-side (service role), never from the client, so achievements are earned rather than self-granted
 - Catalog: Profile set up, First stream, Full house (all platforms linked), Used Raid Finder, In the Spotlight, Told us your vibe, Feeling lucky (Random Streamer button), Playing the field (filtered by a live game), Multi-streaming (2+ platforms live at once), Regular (went live 5 times)
 - New `times_live` counter column on profiles, incremented by the live-status poller on each offline -> live transition, powering the Regular achievement
 - The live-status poller now also computes the homepage Spotlight winner itself each 3-minute run (same lowest-viewer, exemption-aware selection as the homepage) and awards In the Spotlight authoritatively - not left up to whichever visitor's browser happens to be looking at the time
 - New `award-achievement` Netlify function - an authenticated endpoint the client calls when a signed-in streamer does something achievement-worthy. Self-reported achievements (Used Raid Finder, Feeling lucky, Playing the field) are awarded on request since there's no way to verify more than "this happened just now" - same honesty limit as not being able to confirm a raid actually went through on Twitch. Profile-state achievements (Profile set up, Full house, Told us your vibe) are re-verified against the saved profile row before awarding, so the endpoint can't be used to self-grant something that isn't true
 - Private achievements section on the profile edit page - a compact pill strip, earned achievements shown filled, everything else collapsed into a single "N locked" pill with a view all / collapse toggle

## Notes
 - A "checking out other streamers" achievement was considered and deliberately left out for now - verifying it honestly would mean logging which profiles a signed-in user views, which is new data collection worth being deliberate about given the site's minimal-data stance

---

### [2026-08-10] - UPDATES 
## Bug Fixes

## Added
 - is_visible flag on profiles - a manual, reversible moderation tool for hiding channels that are streambotting, showing spam/unrelated content, or otherwise misusing the platform. Distinct from spotlight_exempt (which still shows someone everywhere except the spotlight) - this is a full hide.
 - Hidden profiles are excluded from: the directory, live carousel, spotlight, "Playing Now" chips, the "streamers listed" count, the Raid Finder, and the Discord "who's live" announcer
 - Hidden profiles can no longer be viewed directly via their profile URL either - falls into the same "not found" state as a genuinely nonexistent username, so there's no way to tell "doesn't exist" apart from "was hidden"
 - The 3-minute live-status poller now skips hidden profiles entirely, saving wasted Twitch/YouTube API calls on flagged accounts
hidden_at and hidden_reason fields kept alongside the flag for an internal audit trail - nothing is ever deleted, just filtered out while hidden
Notes
 - Filtering happens at the database query level, not just hidden via CSS - a hidden profile's data never reaches a visitor's browser in the first place
 - Fully reversible: flip is_visible back to true and clear the other two fields to restore a profile
 
---

### [2026-08-07] - UPDATES 
## Bug Fixes
 - Hit issue this morning where no profiles were being displayed. Infrastructure issue (database). Supabase upgrade resolved.
 - Issue processing streamers live status', viewer counts etc as these are serialised at present for Twitch & YouTube. Updating function to run batches of 8 in parallel.

## Added
 - Added new Timezone for Newfoundland
 - Added Discord Announcements for streamers who are live. (with caveats)
 - Added button to Raid card to allow streamer to go check out the intended err...raidee, before committing. 

---

### [2026-08-06] - UPDATES 
## Bug Fixes
 - Minor updates to the "Find Me a Raid" button.
 - Minor fix to prevent already logged in users receiving the CTA for Discord when updating their profile.
 - Minor update to clarify the search box. Show magnifying glass and clear method of removing the contents from the search field which in turn resets the directory back to a full listing. 

## Added
 - Local languages names with English equivalent in parentheses. Included on main directory, profiles and streamer pages.
 - Find me a raid option
 - Additional items on Profile page for "Vibe" used when determining initial Raid candidate streams
 - Introduce message of the day modal
 - DJ category added to profile checkboxes and homepage genre filter.
 - "Playing Now" chip row on the homepage, above the Spotlight - shows what games are currently being streamed across the site, most-played first (e.g. "Hollow Knight × 2"). Capped at 6 chips with a "+N more" overflow indicator to keep it a quick glance, not a wall of tags. Only appears when someone's actually live
 - Clicking a chip filters the directory to that game and smoothly scrolls straight to the results - no manual scrolling required
 - Spotlight exemption toggle (spotlight_exempt on profiles) - lets a streamer be manually excluded from ever being picked for the homepage Spotlight, without hiding them anywhere else on the site. Built for edge cases like AFK streams, hosting someone else's clips, or long-running VODs that are technically "live" by the platform's API but not genuinely active content. Toggle via Supabase, takes effect immediately
 - Notes
  - The chip list is entirely client-side - no new database columns or backend changes, just smarter use of data already being tracked
  - Spotlight exemption was prompted by a real case: an AFK stream looping TikTok clips landed in the spotlight purely by having low viewers

---

## [2026-05-08] - Additional Functionality added from feedback

### BUG FIXES
- Amended to remove Kick Live Status checking as this is being blocked by the API. Changing YouTube approach to use the free redirect-based live detection as we're burning through API credits now that numbers have increased.

### Added
- Here's what changed:
Username and badges are now on separate lines. Previously they shared one flex row that could wrap unpredictably (which is exactly what caused the "OG" badge to sometimes float onto its own awkward line, like you saw with mancavehawkeye's card).

Badges now have a dedicated row with a reserved min-height. Whether a streamer has zero badges, one, or five, that row always takes up the same vertical space - invisible when empty, populated when there are badges to show. This keeps every card's header the same height regardless of badge count, so avatars and content line up cleanly across the whole grid.
- Gap 1 - display bug. Directory grid cards for live streamers currently just say "Live Now · 12 viewers" - no game name at all, even though we track it (live_game) and already show it prominently on the carousel and spotlight cards. So if someone's browsing the main directory and a streamer's live, you literally can't see what they're playing without clicking into their profile. That's a real oversight and an easy fix.

Gap 1 fixed. Two changes:

The actual fix - live streamers on the directory grid now show ● Live Now - Hollow Knight: Silksong · 👁 12 viewers instead of just ● Live Now · 👁 12 viewers. The game name comes from the same live_game field already powering the carousel and spotlight, so this was purely a display gap on the grid cards specifically.

A defensive tweak alongside it - added flex-wrap to the meta line's CSS. With game names now potentially stacking alongside viewer count, timezone, and language on one line, a long title could've overflowed and gotten silently clipped by the card's overflow: hidden. Now it'll gracefully wrap onto a second line instead of disappearing.

- What I've fixed: changed the select('*') to only pull the ~20 columns the homepage actually renders (username, bio, platform links, live status, etc.) instead of everything including unused fields. Small optimisation, but it reduces the payload size and read cost on every single visit.

- VTuber added to both the profile checkboxes and the homepage genre filter.

- Profile form has a new "Preferred Platform" dropdown that only shows platforms they've actually linked (updates live as they type URLs), so someone like TheJiggyJoe could set YouTube as preferred even though Twitch normally wins by default.

- Streamer page shows the "Also live on" band exactly like the mockup - nested inside the same red-tinted live banner card, dot-plus-pill styling, only appears when someone's genuinely multi-streaming.

- Directory and carousel cards now use a single shared pill-rendering system across the board - spotlight, carousel, and grid all call the same helper. Live platforms get solid colour fills with a dot; linked-but-offline platforms get the muted outline treatment with a muted dot, exactly matching what we mocked up together. As a bonus, the directory grid cards' platform badges are now actually clickable too, they were static, non-clickable spans before this, so this is a genuine upgrade for every streamer, not just multi-streamers.

- Cleaned up all the old, now-unused CSS from the previous single-pill system so the stylesheet doesn't carry dead weight.

- Fixed
 - YouTube live detection was silently failing for everyone - root cause was the official YouTube Data API's search.list call (100 quota units per request) blowing through the entire 10,000-unit daily quota within minutes, given the number of linked YouTube channels
 - Kick live detection was being silently blocked by Kick's bot-protection ("Request blocked by security policy")

- Changed
 - YouTube detection rebuilt on YouTube's internal "InnerTube" API - the same API youtube.com's own web player uses, and the technique used by tools like yt-dlp. Uses a public client key, not subject to the Developer API's daily quota
 - YouTube channel handles are now resolved to a channel ID once and cached (youtube_channel_id column) instead of being re-resolved via the paid API on every 3-minute poll - cuts quota usage dramatically as the platform grows
 - The official API is now only used for a single cheap videos.list call (1 unit, not 100) to fetch viewer count, and only for channels already confirmed live
 - Stream title and thumbnail now come from YouTube's free oEmbed endpoint - no API key, no quota cost
 - Kick live detection disabled - Kick remains a fully supported platform link (same as Rumble, TikTok, Velora) but live/offline status can no longer be reliably detected from a serverless function. Revisit if Kick ever ships an official API

 - Added
 - Multi-platform live support: streamers can now be tracked as live on more than one platform simultaneously (live_platforms array). Previously only one "primary" platform was ever recorded, even if someone was multi-streaming
 - Preferred Platform setting on profiles - lets a streamer choose which platform gets top billing (the main "Watch Now" button) when they're live on more than one at once. Falls back to a sensible default order (Twitch > Kick > YouTube) if no preference is set or their preferred platform isn't currently live
 - "Also live on" band on streamer profile pages - when someone's multi-streaming, every other platform they're currently live on now shows as a clickable pill alongside the main Watch Now button
 - Live-aware platform pills across the directory grid, live carousel, and spotlight - platforms a streamer is genuinely live on right now render as solid coloured pills with a dot; linked-but-currently-offline platforms render muted/outlined, so viewers can see at a glance which links will actually take them to a live stream

- Notes
 - Kick's WAF block and YouTube's quota ceiling were both discovered via a real tester (TheJiggyJoe) reporting he was live on three platforms but only Twitch was showing - thanks to him and velsiraptor for patiently staying live while this got debugged

---

## [2026-04-08] - BUG FIXES

### Bug Fixes
- Updated link to Bluesky from x_TapTap_x profile, to appropriate nobodyswatching.live profile

- The bug: With 3+ live streamers, cards get duplicated and wrapped in a .live-carousel-inner div for the seamless auto-scroll loop. But with 2 or fewer, the code skipped that wrapper entirely - no inner div, no scroll mechanism, cards just sat static and cramped. Worse, our drag/swipe script specifically looks for .live-carousel-inner to attach to, so with no wrapper present, it silently did nothing. You were stuck.
- The fix:
The inner wrapper is now always created, regardless of streamer count
With 3+ live: same as before - duplicated cards, seamless auto-scroll loop
With 1-2 live: no duplication, no auto-scroll animation (nothing to loop), but the drag/swipe script now works properly - you can swipe to see the second card if it's cut off at the edge
The drag logic itself needed updating too - it previously assumed content was always duplicated (used for calculating wrap-around math). Now it detects whether duplication happened and switches between two modes: infinite wrap for 3+ cards, and clamped drag (can't overscroll past the first/last card) for 1-2 cards

- The bug: Spotlight platform pills - these never had colour classes defined (.plat-twitch, .plat-youtube etc. existed for the carousel cards but not for the spotlight card), so they were falling back to default browser link styling - plain blue, underlined. 
- The Fix: They now match the carousel's pill styling exactly: purple for Twitch, red for YouTube, green for Kick, and so on.

- The bug: Viewer count badge contrast 
- The fix: Bumped the background opacity from 0.75 to 0.85, added a subtle border and drop shadow, and gave it z-index: 2 so it always sits clearly above the thumbnail image regardless of how busy or dark the game footage is behind it.

---

## [2026-04-08] - Additional Functionality added from feedback

### Added
- Here's what's new - a proper "Your Identity" section at the top of the profile form, above the bio:
Editable Display Name - text input, max 30 characters, pre-filled with whatever their provider gave us. Hint text specifically calls out the Google/YouTube mismatch issue so people understand why it might be wrong. Live-updates the preview name above as they type.

Editable Avatar URL - paste any direct image link (their YouTube channel photo, Twitch avatar, whatever). Live-updates the preview image too.

Smart subtext - the "Pulled from Twitch. Looking good." line now only shows for Twitch users. Google users get "Pulled from your Google account - edit below if it doesn't match your channel," which directly explains the mismatch rather than leaving them confused.

Validation on save - can't save with an empty display name, and it's capped at 30 characters to prevent layout-breaking usernames.

- #11 - Rerun fallback spotlight. The polling function no longer discards reruns entirely - it tags them with is_rerun: true instead. The carousel still excludes reruns completely (never shown there). But the spotlight now has smart fallback logic: if anyone's genuinely live, spotlight picks the lowest-viewer genuine streamer as before. If nobody is genuinely live, it falls back to the rerun with the fewest viewers, with a clearly different label (↻ Nothing live - here's a rerun), a muted grey border instead of teal, and honest copy explaining it's replaying old content. Nobody gets misled into thinking a rerun is a live stream.

- #12 - Watch Now button colour. Now dynamically matches whichever platform they're actually live on - purple for Twitch, red for YouTube, kick-green for Kick. If they're offline, it colours based on their primary linked platform instead.

- #13 - Genres and platforms. Added Story Games and Rhythm Games to both the profile checkboxes and homepage filters. Added Velora as new platform link fields, following the same pattern as Rumble/TikTok.

- #14 - Viewer count on directory cards. Live streamers now show 👁 X viewers in their card meta line on the main directory grid, regardless of whether they're under the 75-viewer carousel cap. So a streamer with 200 viewers still shows their live status and count on their card, they just won't appear in the carousel itself.

- Added search bar so that the user can search for a game rather than a Genre i.e. Minecraft

- Added Language options for the Streamer profile. You can write your BIO in any language you wish and now find streamers in any language simply by selecting it on the front page.

- Expanded genres (profile.html + index.html) - 12 new categories added: Roguelike, Simulation, MMORPG, Fighting, Puzzle, Retro, Art, Music, Just Chatting, Makers & Crafting, Cooking, and IRL. Both the profile checkboxes and the homepage filter buttons are updated. Existing profiles keep their current genres - the new options just appear alongside them.

- Random re-roll button (streamer.html) - A "🎲 Discover Another Streamer" button sits below the share section on every streamer profile page. Clicking it loads a random different streamer (it excludes the one you're currently viewing). Gold hover effect matching the Random button on the homepage. No more navigating back to the directory to re-roll.

- Bio line breaks (index.html + streamer.html) - Newlines in bios now render as <br> tags on both the directory cards and the streamer profile page. The text is still escaped first via esc() so there's no HTML injection risk - we escape everything, then convert \n to <br>. The profile form already uses a textarea, so people can just hit Enter to add line breaks.

- Spotlight section (index.html) - When anyone's live, the streamer with the fewest viewers gets a prominent "⭐ Spotlight" card above the carousel. It's got a teal-bordered card with a subtle glow, their thumbnail, username, badges, game, viewer count, and platform pills. The tagline underneath says "👁 X viewers - be the one who changes that". On mobile it stacks vertically. This directly addresses feedback #9 - it grabs attention better than the carousel alone and gives the smallest streamers the biggest visibility.

- Viewer cap on carousel (index.html) - Streamers with more than 75 viewers are hidden from the live carousel. They're still on the site, still in the directory, still have their profile page - they just don't take up carousel space that could go to someone smaller. 75 felt right as a starting point - high enough that growing streamers don't feel punished, low enough to keep the carousel true to its mission. Easy to adjust the VIEWER_CAP constant if you want to change it later.

- Rerun filter (check-live-status.mjs) - The polling function now skips Twitch streams where type is anything other than "live" (catches reruns at the API level), and also checks tags for "rerun" or "rebroadcast" as a belt-and-braces measure. So rerun channels won't appear in the live carousel anymore.
  
---

## [2026-04-08] - TikTok Platform Support

### Added
- TikTok as a platform link option on streamer profiles
- TikTok pink pill on directory cards and live carousel
- TikTok link card on individual streamer profile pages

---

## [2026-04-07] - Google Sign-In, Rumble, Auto-Scroll Carousel

### Added
- Google OAuth as alternative sign-in method (for YouTube-primary streamers)
- Sign-in modal with Twitch and Google options
- Rumble as a platform link option
- Live carousel auto-scrolls with mouse drag / touch swipe support
- Carousel pauses on hover, resumes after 3 seconds
- Streamer Pack section on About page (panel image, copy-paste text, chat command, social bio)
- Twitch panel image (320x100) available for download

### Changed
- Privacy policy updated for YouTube API Services compliance
- "How It Works" section updated to mention both sign-in providers
- Identity linking enabled in Supabase (same email = same account across providers)

---

## [2026-04-04] - Platform Pills, Bio Overflow Fix

### Added
- Clickable platform pills on live carousel cards (Twitch, YouTube, Kick)
- Viewers can jump directly to their preferred platform from live cards

### Fixed
- Bio text overflow on streamer cards and profile pages (long unbroken strings)
- Streamer page container overflow on desktop

---

## [2026-04-03] - Badges, Random Streamer, Multi-Platform Live Detection

### Added
- Badge system: Founder, Tester, OG, Supporter - displayed as coloured pills next to usernames
- Random Streamer button in directory filters
- Kick live detection via unofficial API (no auth required)
- YouTube live detection via YouTube Data API v3 (optional, requires API key)
- Multi-platform priority system: Twitch > Kick > YouTube for live status
- "+ Add" button for game tags on profile (fixes mobile keyboard issue)

### Changed
- Live polling function now checks Twitch, Kick, and YouTube in parallel
- Game tag input improved for mobile compatibility

---

## [2026-04-02] - Mobile Fixes, Nav Dropdown, Discord Link

### Fixed
- Mobile layout broken by hero/CTA glow effects (overflow:hidden on sections)
- Nav sign-in button disappearing on mobile (glow causing invisible overflow)
- Nav dropdown menu clipped on desktop (removed overflow:hidden from nav)
- Discord invite link updated to non-expiring link

---

## [2026-03-30] - Launch

### Added
- Homepage with hero, live carousel, directory, "How It Works", CTA, stats bar
- Twitch OAuth sign-in
- Profile creation and editing (bio, timezone, genres, top games, platform links)
- Live directory with genre and timezone filters
- Twitch live status polling every 3 minutes via Netlify Scheduled Functions
- Public streamer profile pages with shareable URLs
- About page and Privacy policy
- Favicon (circle + dot + status bar motif)
- OG meta tags for social sharing
- Dark theme with teal/cyan accents, JetBrains Mono section markers
- Custom domain: nobodyswatching.live
