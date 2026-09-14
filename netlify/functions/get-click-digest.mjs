// =============================================
// NOBODYSWATCHING.LIVE — Click digest endpoint
// Called from profile.html, once per page load, to check whether a
// signed-in streamer has a monthly click digest worth showing. Not
// scheduled — invoked directly at /.netlify/functions/get-click-digest.
//
// Returns only the caller's own previous-month click total, never
// anyone else's. Never touches outbound_clicks directly from the
// client — that table has zero read policies by design (see
// migration-outbound-clicks.sql) and this endpoint doesn't change that,
// it's the one narrow, purpose-built exception that reads it server-side.
//
// Auth pattern matches award-achievement.mjs exactly: a single
// service-role client, used both to verify the caller's JWT (via
// getUser) and to perform the read.
// =============================================

import { createClient } from '@supabase/supabase-js';

export default async function handler(request) {
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error('Missing required environment variables');
        return new Response('Missing config', { status: 500 });
    }

    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
        return new Response('Missing auth token', { status: 401 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
        return new Response('Invalid session', { status: 401 });
    }

    // Current month, e.g. "2026-09" — the caller compares this against
    // their stored last_click_digest_month to decide whether they've
    // already seen this month's digest, then writes it back themselves
    // on dismiss (same direct-update pattern as has_seen_discord_nudge).
    // Computed here, not on the client, so it can't drift from the
    // server's own idea of "this month" that get_previous_month_clicks
    // used to compute the total below.
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const { data: clicks, error: clicksError } = await supabase
        .rpc('get_previous_month_clicks', { p_profile_id: user.id });

    if (clicksError) {
        console.error('get_previous_month_clicks failed:', clicksError.message);
        return new Response('Could not load digest', { status: 500 });
    }

    return new Response(JSON.stringify({ clicks, currentMonth }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}
