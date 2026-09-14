// =============================================
// NOBODYSWATCHING.LIVE — Outbound click tracker
// Called from the client (index.html / streamer.html) whenever a visitor
// clicks a link that genuinely leaves the site for a streamer's channel.
// Not scheduled — invoked directly at /.netlify/functions/track-click.
//
// Fire-and-forget, unauthenticated (visitors clicking a public link were
// never signed in), and deliberately minimal: no visitor identity, no
// session, no IP or user-agent logged anywhere — see
// migration-outbound-clicks.sql for the full reasoning. This function's
// only job is to validate the shape of the request and hand the count
// off to record_outbound_click(), which does the actual write.
//
// The client fires this with navigator.sendBeacon and never reads the
// response, so there is nothing here for a person to see — only logs.
// =============================================

import { createClient } from '@supabase/supabase-js';

// Anything not in these two lists is rejected outright, which is also
// what keeps a typo (or a deliberately weird value from someone poking
// the endpoint by hand) from silently accumulating in the table under
// its own new label forever.
const VALID_SOURCES = new Set([
    'carousel',
    'spotlight',
    'directory',
    'raid_finder',
    'also_live',
    'profile',
    'watch_now'
]);

const VALID_PLATFORMS = new Set([
    'twitch',
    'youtube',
    'kick',
    'rumble',
    'tiktok',
    'velora'
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Origin-check only, as agreed — this stops a casual "view source, copy
// the fetch call" attempt, not a determined one. A script that sets its
// own Origin/Referer header sails straight through, and that's an
// accepted trade-off: the table has no public read policy regardless,
// so the worst case is a slightly inflated internal count, not exposed
// data. Add production/staging hostnames here as they come up.
const ALLOWED_HOSTNAMES = new Set([
    'nobodyswatching.live',
    'www.nobodyswatching.live'
]);

function hostnameAllowed(request) {
    for (const header of ['origin', 'referer']) {
        const value = request.headers.get(header);
        if (!value) continue;
        try {
            const hostname = new URL(value).hostname;
            if (ALLOWED_HOSTNAMES.has(hostname)) return true;
        } catch {
            // Malformed header — ignore and keep checking the other one.
        }
    }
    return false;
}

export default async function handler(request) {
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    if (!hostnameAllowed(request)) {
        return new Response('Origin not allowed', { status: 403 });
    }

    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error('Missing required environment variables');
        return new Response('Missing config', { status: 500 });
    }

    // sendBeacon sends a Blob body, typically with Content-Type
    // "text/plain" unless the caller explicitly constructs one with an
    // "application/json" type. We accept it as text either way and parse
    // it ourselves rather than trusting the Content-Type header.
    let body;
    try {
        const raw = await request.text();
        body = JSON.parse(raw);
    } catch {
        return new Response('Invalid JSON body', { status: 400 });
    }

    const { profileId, source, platform } = body || {};

    if (typeof profileId !== 'string' || !UUID_RE.test(profileId)) {
        return new Response('Invalid profileId', { status: 400 });
    }
    if (!VALID_SOURCES.has(source)) {
        return new Response('Invalid source', { status: 400 });
    }
    if (!VALID_PLATFORMS.has(platform)) {
        return new Response('Invalid platform', { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { error } = await supabase.rpc('record_outbound_click', {
        p_profile_id: profileId,
        p_source: source,
        p_platform: platform
    });

    if (error) {
        // A bad-but-UUID-shaped profileId (doesn't exist in profiles)
        // fails here as a foreign-key violation, not earlier — that's
        // fine, it's still just a 400, no different data exposed either
        // way.
        console.error('record_outbound_click failed:', error.message);
        return new Response('Could not record click', { status: 400 });
    }

    // 204: nothing to say, and sendBeacon isn't listening anyway.
    return new Response(null, { status: 204 });
}
