// =============================================
// NOBODYSWATCHING.LIVE — Multi-Platform Live Status Checker
// Runs every 3 minutes via Netlify Scheduled Functions
// Supports: Twitch, Kick, YouTube (optional)
// =============================================

import { createClient } from '@supabase/supabase-js';
import { loadAchievementIds, award } from './lib/achievements.mjs';

export const config = {
    schedule: "*/3 * * * *"
};

// =============================================
// CONCURRENCY HELPER
//
// Runs async work in parallel, but capped at a fixed number running at
// once — a middle ground between "fully sequential" (too slow as the
// user base grows, risks the function timing out) and "fully unbounded
// Promise.all" (risks looking like burst/attack traffic to an unofficial
// API and getting blocked, exactly what happened to us with Kick).
// =============================================
async function mapWithConcurrency(items, concurrency, workerFn) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await workerFn(items[i]);
        }
    }

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

// =============================================
// TWITCH
// =============================================
async function getTwitchToken(clientId, clientSecret) {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'client_credentials'
        })
    });
    if (!response.ok) throw new Error(`Twitch token error: ${response.status}`);
    const data = await response.json();
    return data.access_token;
}

async function checkTwitchLive(usernames, clientId, accessToken) {
    if (usernames.length === 0) return new Map();

    // Build all the 100-user batches, then fetch them all at once instead
    // of one after another — this is the official Twitch API, so there's
    // no burst-detection risk here like there is with YouTube's InnerTube.
    const batches = [];
    for (let i = 0; i < usernames.length; i += 100) {
        batches.push(usernames.slice(i, i + 100));
    }

    const batchResults = await Promise.all(batches.map(async (batch) => {
        const params = batch.map(u => `user_login=${encodeURIComponent(u)}`).join('&');
        try {
            const response = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
                headers: {
                    'Client-ID': clientId,
                    'Authorization': `Bearer ${accessToken}`
                }
            });
            if (!response.ok) {
                console.error(`Twitch API error: ${response.status}`);
                return [];
            }
            const data = await response.json();
            return data.data || [];
        } catch (err) {
            console.error('Twitch batch fetch failed:', err.message);
            return [];
        }
    }));

    const allStreams = batchResults.flat();

    const liveMap = new Map();
    for (const stream of allStreams) {
        const isRerun = (stream.type && stream.type !== 'live') ||
            (stream.tags || []).some(t => t.toLowerCase() === 'rerun' || t.toLowerCase() === 'rebroadcast');

        const thumbUrl = stream.thumbnail_url
            ? stream.thumbnail_url.replace('{width}', '440').replace('{height}', '248')
            : null;
        liveMap.set(stream.user_login.toLowerCase(), {
            game: stream.game_name || null,
            viewers: stream.viewer_count || 0,
            thumbnail: thumbUrl,
            platform: 'twitch.tv',
            isRerun: isRerun
        });
    }
    return liveMap;
}

// =============================================
// KICK
//
// Kick's official Public API launched in 2025 — the WAF block that
// took this offline originally applied to Kick's unofficial/scraped
// endpoints, not to api.kick.com. Uses the same client_credentials
// flow as Twitch, but keys off a numeric broadcaster_user_id rather
// than a username, so there's a one-time resolve step — cached, same
// pattern already used below for the YouTube channel ID.
// =============================================
async function getKickToken(clientId, clientSecret) {
    const response = await fetch('https://id.kick.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'client_credentials'
        })
    });
    if (!response.ok) throw new Error(`Kick token error: ${response.status}`);
    const data = await response.json();
    return data.access_token;
}

async function resolveKickBroadcasterId(username, accessToken, cachedBroadcasterId) {
    if (cachedBroadcasterId) return cachedBroadcasterId; // Already resolved on a previous run — skip the lookup
    try {
        const res = await fetch(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(username)}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!res.ok) {
            console.error(`Kick channel resolve returned ${res.status} for ${username}`);
            return null;
        }
        const data = await res.json();
        return data.data?.[0]?.broadcaster_user_id || null;
    } catch (err) {
        console.error(`Kick channel resolve failed for ${username}:`, err.message);
        return null;
    }
}

async function checkKickLive(kickProfiles, accessToken) {
    const liveMap = new Map(); // keyed by username.toLowerCase()
    const resolvedBroadcasterIds = new Map(); // username -> broadcaster_user_id, for anything newly resolved this run

    if (kickProfiles.length === 0) return { liveMap, resolvedBroadcasterIds };

    // Resolve any un-cached usernames to numeric IDs first, capped at 5
    // concurrent — this is Kick's official API, but no reason to hammer
    // it with an unbounded burst just because we technically can.
    const KICK_RESOLVE_CONCURRENCY = 5;
    const idResults = await mapWithConcurrency(kickProfiles, KICK_RESOLVE_CONCURRENCY, async ({ username, cachedBroadcasterId }) => {
        const id = await resolveKickBroadcasterId(username, accessToken, cachedBroadcasterId);
        if (id && !cachedBroadcasterId) {
            resolvedBroadcasterIds.set(username.toLowerCase(), id);
        }
        return id ? { username, id } : null;
    });

    const resolved = idResults.filter(Boolean);
    if (resolved.length === 0) return { liveMap, resolvedBroadcasterIds };

    // GET /livestreams accepts up to 50 broadcaster_user_id params per call
    const batches = [];
    for (let i = 0; i < resolved.length; i += 50) {
        batches.push(resolved.slice(i, i + 50));
    }

    await Promise.all(batches.map(async (batch) => {
        const params = batch.map(b => `broadcaster_user_id=${b.id}`).join('&');
        try {
            const response = await fetch(`https://api.kick.com/public/v1/livestreams?${params}`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            if (!response.ok) {
                console.error(`Kick livestreams API error: ${response.status}`);
                return;
            }
            const data = await response.json();
            const idToUsername = new Map(batch.map(b => [b.id, b.username]));

            for (const stream of data.data || []) {
                const username = idToUsername.get(stream.broadcaster_user_id);
                if (!username) continue;
                liveMap.set(username.toLowerCase(), {
                    game: stream.category?.name || null,
                    viewers: stream.viewer_count || 0,
                    thumbnail: stream.thumbnail || null,
                    platform: 'kick.com'
                });
            }
        } catch (err) {
            console.error('Kick batch fetch failed:', err.message);
        }
    }));

    return { liveMap, resolvedBroadcasterIds };
}

// =============================================
// YOUTUBE — InnerTube-based live detection.
//
// This uses YouTube's own internal "InnerTube" API — the same one
// youtube.com's web player calls under the hood, and the technique
// used by tools like yt-dlp. It uses a public WEB-client key that's
// baked into every YouTube page load, so it isn't subject to the
// Developer API's 10,000-unit daily quota at all.
//
// We still use the official (cheap, 1-unit) channels.list call to
// resolve @handles to a channel ID — that was never the expensive
// part, only search.list (100 units) was, and we no longer use it.
// =============================================
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CONTEXT = {
    client: {
        clientName: 'WEB',
        clientVersion: '2.20240101.00.00'
    }
};

async function resolveYouTubeChannelId(identifier, type, apiKey, cachedChannelId) {
    if (type === 'channel_id') return identifier;
    if (cachedChannelId) return cachedChannelId; // Already resolved on a previous run — skip the API call
    if (!apiKey) return null;
    try {
        const res = await fetch(
            `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(identifier)}&key=${apiKey}`
        );
        if (!res.ok) {
            console.error(`YouTube handle resolve returned ${res.status} for ${identifier}`);
            return null;
        }
        const data = await res.json();
        return data.items?.[0]?.id || null;
    } catch (err) {
        console.error(`YouTube handle resolve failed for ${identifier}:`, err.message);
        return null;
    }
}

// Search the raw InnerTube response TEXT for the specific "currently live"
// thumbnail badge marker, then find the nearest videoId to it.
//
// Confirmed via production diagnostics (2026-08-05): the exact marker
// YouTube uses for a genuinely-live-right-now video is
// "badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE". Looser patterns
// like a bare "LIVE" or "style":"LIVE" produce false positives — they
// also match things like "LIVESTREAM ARCHIVE" (a past stream that's
// now just a VOD) and generic liveBadgeText fields unrelated to
// current live status.
function findLiveVideoId(rawText) {
    const liveMarkerMatch = rawText.match(/"badgeStyle":\s*"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"/);
    if (!liveMarkerMatch) return null;

    const liveIndex = liveMarkerMatch.index;

    // Search the WHOLE document for videoId occurrences and pick whichever
    // is closest to the live marker, rather than guessing a window size.
    // These responses are pretty-printed and can be large (up to ~1MB),
    // but a full-document regex scan is still cheap for a job that only
    // runs once every 3 minutes.
    const videoIdMatches = [...rawText.matchAll(/"videoId":\s*"([a-zA-Z0-9_-]{11})"/g)];
    if (videoIdMatches.length === 0) return null;

    let closest = null;
    let closestDist = Infinity;
    for (const m of videoIdMatches) {
        const dist = Math.abs(m.index - liveIndex);
        if (dist < closestDist) {
            closestDist = dist;
            closest = m[1];
        }
    }
    return closest;
}

async function checkYouTubeLive(channelIdentifiers, apiKey) {
    const liveMap = new Map();
    const resolvedChannelIds = new Map(); // identifier -> channelId, for anything newly resolved this run

    // Process channels several at a time instead of one after another —
    // this was the actual cause of the function timing out as the number
    // of YouTube-linked profiles grew. Capped at 8 concurrent, not
    // unbounded: InnerTube is an unofficial API, and a sudden burst of
    // 100+ simultaneous requests risks getting flagged/blocked the same
    // way Kick's official-looking API blocked us for exactly this kind
    // of traffic pattern.
    const YOUTUBE_CONCURRENCY = 8;

    await mapWithConcurrency(channelIdentifiers, YOUTUBE_CONCURRENCY, async ({ identifier, type, cachedChannelId }) => {
        try {
            const channelId = await resolveYouTubeChannelId(identifier, type, apiKey, cachedChannelId);
            if (!channelId) {
                console.log(`YouTube check for ${identifier}: could not resolve channel ID, skipping`);
                return;
            }
            if (!cachedChannelId) {
                resolvedChannelIds.set(identifier.toLowerCase(), channelId);
            }

            const response = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.youtube.com',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                },
                body: JSON.stringify({
                    context: INNERTUBE_CONTEXT,
                    browseId: channelId
                })
            });

            if (!response.ok) {
                const bodySnippet = await response.text().catch(() => '');
                console.error(`YouTube InnerTube browse returned ${response.status} for ${identifier}: ${bodySnippet.slice(0, 200)}`);
                return;
            }

            const rawText = await response.text();
            const videoId = findLiveVideoId(rawText);

            if (!videoId) return; // Not live

            // Free oEmbed call for title + thumbnail — no API key, no quota
            let title = null;
            let thumbnail = null;
            try {
                const oembedRes = await fetch(
                    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
                );
                if (oembedRes.ok) {
                    const oembedData = await oembedRes.json();
                    title = oembedData.title || null;
                    thumbnail = oembedData.thumbnail_url || null;
                }
            } catch (e) { /* title/thumbnail are nice-to-have */ }

            // Cheap, targeted Data API call (1 unit) for viewer count only —
            // only runs for channels we already know are live right now.
            let viewers = 0;
            if (apiKey) {
                try {
                    const statsRes = await fetch(
                        `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${apiKey}`
                    );
                    if (statsRes.ok) {
                        const statsData = await statsRes.json();
                        viewers = parseInt(statsData.items?.[0]?.liveStreamingDetails?.concurrentViewers || '0');
                    } else {
                        const bodySnippet = await statsRes.text().catch(() => '');
                        console.error(`YouTube viewer count lookup returned ${statsRes.status} for ${identifier}: ${bodySnippet.slice(0, 200)}`);
                    }
                } catch (e) {
                    console.error(`YouTube viewer count fetch failed for ${identifier}:`, e.message);
                }
            }

            liveMap.set(identifier.toLowerCase(), {
                game: title,
                viewers: viewers,
                thumbnail: thumbnail,
                platform: 'youtube.com',
                videoUrl: `https://www.youtube.com/watch?v=${videoId}`
            });
        } catch (err) {
            console.error(`YouTube check failed for ${identifier}:`, err.message);
        }
    });

    return { liveMap, resolvedChannelIds };
}

// =============================================
// URL PARSERS
// =============================================
function extractKickUsername(url) {
    if (!url) return null;
    const match = url.match(/kick\.com\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

function extractYouTubeIdentifier(url) {
    if (!url) return null;
    const handleMatch = url.match(/youtube\.com\/@([a-zA-Z0-9_-]+)/);
    if (handleMatch) return { identifier: handleMatch[1], type: 'handle' };
    const channelMatch = url.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/);
    if (channelMatch) return { identifier: channelMatch[1], type: 'channel_id' };
    return null;
}

// =============================================
// MAIN HANDLER
// =============================================
export default async function handler() {
    const {
        TWITCH_CLIENT_ID,
        TWITCH_CLIENT_SECRET,
        KICK_CLIENT_ID,
        KICK_CLIENT_SECRET,
        YOUTUBE_API_KEY,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY
    } = process.env;

    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error('Missing required environment variables');
        return new Response('Missing config', { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
        // 1. Get all VISIBLE profiles — no point spending Twitch/YouTube
        // API calls checking live status on channels that have already
        // been hidden for streambotting or spam content.
        const { data: profiles, error: fetchError } = await supabase
            .from('profiles')
            .select('id, twitch_username, kick_url, kick_broadcaster_id, youtube_url, youtube_channel_id, is_live, preferred_platform, spotlight_exempt, times_live')
            .eq('is_visible', true);

        if (fetchError) {
            console.error('Supabase fetch error:', fetchError);
            return new Response('DB error', { status: 500 });
        }

        if (!profiles || profiles.length === 0) {
            console.log('No profiles found');
            return new Response('No profiles to check', { status: 200 });
        }

        console.log(`Checking ${profiles.length} streamer(s) across platforms...`);

        // 2. Collect usernames per platform
        const twitchUsernames = profiles
            .map(p => p.twitch_username)
            .filter(Boolean);

        const kickChannels = profiles
            .map(p => {
                const username = extractKickUsername(p.kick_url);
                if (!username) return null;
                return { username, cachedBroadcasterId: p.kick_broadcaster_id || null };
            })
            .filter(Boolean);

        const youtubeChannels = profiles
            .map(p => {
                const info = extractYouTubeIdentifier(p.youtube_url);
                if (!info) return null;
                return { ...info, cachedChannelId: p.youtube_channel_id || null };
            })
            .filter(Boolean);

        console.log(`Found: ${twitchUsernames.length} Twitch, ${kickChannels.length} Kick, ${youtubeChannels.length} YouTube`);

        // 3. Check all platforms in parallel
        const twitchToken = twitchUsernames.length > 0
            ? await getTwitchToken(TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET)
            : null;

        const kickToken = (KICK_CLIENT_ID && KICK_CLIENT_SECRET && kickChannels.length > 0)
            ? await getKickToken(KICK_CLIENT_ID, KICK_CLIENT_SECRET)
            : null;

        const [twitchLive, kickResult, youtubeResult] = await Promise.all([
            twitchToken ? checkTwitchLive(twitchUsernames, TWITCH_CLIENT_ID, twitchToken) : new Map(),
            kickToken ? checkKickLive(kickChannels, kickToken) : { liveMap: new Map(), resolvedBroadcasterIds: new Map() },
            youtubeChannels.length > 0 ? checkYouTubeLive(youtubeChannels, YOUTUBE_API_KEY) : { liveMap: new Map(), resolvedChannelIds: new Map() }
        ]);

        const kickLive = kickResult.liveMap;
        const newlyResolvedBroadcasterIds = kickResult.resolvedBroadcasterIds;

        const youtubeLive = youtubeResult.liveMap;
        const newlyResolvedChannelIds = youtubeResult.resolvedChannelIds;

        console.log(`Live: ${twitchLive.size} Twitch, ${kickLive.size} Kick, ${youtubeLive.size} YouTube`);

        // 3a. Persist any newly-resolved Kick broadcaster IDs so future runs
        // skip the resolve step for these profiles entirely.
        if (newlyResolvedBroadcasterIds.size > 0) {
            const kickIdUpdates = profiles
                .filter(p => {
                    const username = extractKickUsername(p.kick_url);
                    return username && newlyResolvedBroadcasterIds.has(username.toLowerCase());
                })
                .map(p => {
                    const username = extractKickUsername(p.kick_url);
                    const broadcasterId = newlyResolvedBroadcasterIds.get(username.toLowerCase());
                    return supabase.from('profiles').update({ kick_broadcaster_id: broadcasterId }).eq('id', p.id);
                });
            await Promise.all(kickIdUpdates);
            console.log(`Cached ${kickIdUpdates.length} newly-resolved Kick broadcaster ID(s)`);
        }

        // 3b. Persist any newly-resolved YouTube channel IDs so future runs
        // skip the paid resolve step for these profiles entirely.
        if (newlyResolvedChannelIds.size > 0) {
            const idUpdates = profiles
                .filter(p => {
                    const info = extractYouTubeIdentifier(p.youtube_url);
                    return info && info.type === 'handle' && newlyResolvedChannelIds.has(info.identifier.toLowerCase());
                })
                .map(p => {
                    const info = extractYouTubeIdentifier(p.youtube_url);
                    const channelId = newlyResolvedChannelIds.get(info.identifier.toLowerCase());
                    return supabase.from('profiles').update({ youtube_channel_id: channelId }).eq('id', p.id);
                });
            await Promise.all(idUpdates);
            console.log(`Cached ${idUpdates.length} newly-resolved YouTube channel ID(s)`);
        }

        // 4. Build combined live status per profile.
        // A streamer can be live on more than one platform at once — we track
        // ALL of them, then pick a "primary" one for the main Watch Now button:
        // their preferred_platform if it's currently live, otherwise the
        // fallback priority order: Twitch > Kick > YouTube.
        const PLATFORM_KEY_MAP = {
            twitch: 'twitch.tv',
            kick: 'kick.com',
            youtube: 'youtube.com'
        };

        // Achievement catalog, loaded once per run. Writes always go through
        // this service-role client, never the client directly — see
        // netlify/functions/lib/achievements.mjs for why.
        const achievementIds = await loadAchievementIds(supabase);

        const updateOps = [];
        const awardOps = [];
        // Snapshot of everyone genuinely (or rerun) live this run, used below
        // to pick the Spotlight winner the same way the homepage does —
        // computed here too so it can be awarded server-side.
        const liveSnapshot = [];

        for (const profile of profiles) {
            // Collect every platform this profile is currently live on
            const liveEntries = []; // [{ key: 'twitch.tv', data: {...} }, ...]

            if (profile.twitch_username) {
                const tStream = twitchLive.get(profile.twitch_username.toLowerCase());
                if (tStream) liveEntries.push({ key: 'twitch.tv', data: tStream });
            }
            const kickUser = extractKickUsername(profile.kick_url);
            if (kickUser) {
                const kStream = kickLive.get(kickUser.toLowerCase());
                if (kStream) liveEntries.push({ key: 'kick.com', data: kStream });
            }
            const ytInfo = extractYouTubeIdentifier(profile.youtube_url);
            if (ytInfo) {
                const yStream = youtubeLive.get(ytInfo.identifier.toLowerCase());
                if (yStream) liveEntries.push({ key: 'youtube.com', data: yStream });
            }

            if (liveEntries.length > 0) {
                // Try the streamer's preferred platform first, if it's live right now
                const preferredKey = PLATFORM_KEY_MAP[profile.preferred_platform];
                let primary = preferredKey
                    ? liveEntries.find(e => e.key === preferredKey)
                    : null;

                // Fall back to fixed priority order: Twitch > Kick > YouTube
                if (!primary) {
                    primary = liveEntries.find(e => e.key === 'twitch.tv')
                        || liveEntries.find(e => e.key === 'kick.com')
                        || liveEntries.find(e => e.key === 'youtube.com');
                }

                // Store the direct YouTube watch URL independently of whether
                // YouTube ended up being the "primary" platform — the "Also
                // live on" pills need this too when YouTube isn't primary.
                const ytEntry = liveEntries.find(e => e.key === 'youtube.com');

                // Only count as a "new" stream — for the times_live counter and
                // the First stream / Regular achievements — on an offline -> live
                // transition, not on every 3-minute poll while already live.
                const wasLive = !!profile.is_live;
                const newTimesLive = wasLive ? (profile.times_live || 0) : (profile.times_live || 0) + 1;

                updateOps.push(
                    supabase
                        .from('profiles')
                        .update({
                            is_live: true,
                            is_rerun: primary.data.isRerun || false,
                            live_game: primary.data.game,
                            live_viewer_count: primary.data.viewers,
                            live_thumbnail_url: primary.data.thumbnail,
                            live_platform: primary.key,
                            live_platforms: liveEntries.map(e => e.key),
                            youtube_live_video_url: ytEntry ? ytEntry.data.videoUrl : null,
                            last_live_at: new Date().toISOString(),
                            times_live: newTimesLive
                        })
                        .eq('id', profile.id)
                );

                if (!wasLive) {
                    awardOps.push(award(supabase, achievementIds, profile.id, 'first_stream'));
                    if (newTimesLive >= 5) {
                        awardOps.push(award(supabase, achievementIds, profile.id, 'regular'));
                    }
                }
                if (liveEntries.length >= 2) {
                    awardOps.push(award(supabase, achievementIds, profile.id, 'multi_streaming'));
                }

                liveSnapshot.push({
                    id: profile.id,
                    viewers: primary.data.viewers || 0,
                    isRerun: primary.data.isRerun || false,
                    spotlightExempt: !!profile.spotlight_exempt
                });
            } else if (profile.is_live) {
                updateOps.push(
                    supabase
                        .from('profiles')
                        .update({
                            is_live: false,
                            is_rerun: false,
                            live_game: null,
                            live_viewer_count: 0,
                            live_thumbnail_url: null,
                            live_platform: null,
                            live_platforms: [],
                            youtube_live_video_url: null
                        })
                        .eq('id', profile.id)
                );
            }
        }

        const results = await Promise.all(updateOps);
        const errors = results.filter(r => r.error);

        if (errors.length > 0) {
            console.error(`${errors.length} update(s) failed:`, errors.map(e => e.error));
        }

        // 5. Spotlight — same selection rule as the homepage: the lowest-viewer
        // genuinely-live streamer, falling back to a rerun only if nobody's
        // genuinely live. spotlight_exempt streamers are skipped for both.
        // Computed here (not just client-side) so "In the Spotlight" can be
        // awarded authoritatively, without trusting whichever visitor's
        // browser happens to be looking at the homepage at the time.
        const spotlightCandidates = liveSnapshot.filter(p => !p.isRerun && !p.spotlightExempt);
        const rerunSpotlightCandidates = liveSnapshot.filter(p => p.isRerun && !p.spotlightExempt);

        let spotlightWinner = null;
        if (spotlightCandidates.length > 0) {
            spotlightWinner = [...spotlightCandidates].sort((a, b) => a.viewers - b.viewers)[0];
        } else if (rerunSpotlightCandidates.length > 0) {
            spotlightWinner = [...rerunSpotlightCandidates].sort((a, b) => a.viewers - b.viewers)[0];
        }
        if (spotlightWinner) {
            awardOps.push(award(supabase, achievementIds, spotlightWinner.id, 'hit_spotlight'));
        }

        // 6. Outbound clicks — anyone whose links have collectively been
        // clicked 5+ times gets "Someone's Watching". Same idempotent
        // pattern as everything above: award() no-ops silently if they
        // already have it, so it's safe to re-check every 3 minutes
        // rather than tracking who's already qualified separately.
        const { data: clickQualifiers, error: clickQualifiersError } = await supabase
            .rpc('profiles_over_click_threshold', { p_threshold: 5 });

        if (clickQualifiersError) {
            console.error('Click-threshold check failed:', clickQualifiersError.message);
        } else {
            for (const { profile_id } of clickQualifiers) {
                awardOps.push(award(supabase, achievementIds, profile_id, 'someones_watching'));
            }
        }

        await Promise.all(awardOps);

        const totalLive = twitchLive.size + kickLive.size + youtubeLive.size;
        console.log(`Done. ${updateOps.length} profile(s) updated, ${totalLive} live total, ${awardOps.length} achievement check(s) run`);
        return new Response(`Checked ${profiles.length} profiles, ${totalLive} live`, { status: 200 });

    } catch (err) {
        console.error('Unexpected error:', err);
        return new Response('Internal error', { status: 500 });
    }
}
