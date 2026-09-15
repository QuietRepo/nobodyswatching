// =============================================
// NOBODYSWATCHING.LIVE — Per-profile share cards
//
// Profile pages are /streamer.html?user=<name> and render client side
// from Supabase. Crawlers and link unfurlers do not run JavaScript, so
// every shared profile link used to unfurl as a blank box titled
// "Streamer Profile". This rewrites the <head> for those clients only.
//
// WHY AN EDGE FUNCTION AND NOT A NORMAL ONE:
// a normal function would have to serve the page body for every human
// visit too. This one checks the user agent first and returns straight
// away for real people, so their request goes to the static file
// untouched and costs a string match. Only bots pay for the Supabase
// lookup and the rewrite, and there are very few of those.
//
// Humans still see the original tags in view-source. That is fine -
// nothing reads them except the crawlers we are already handling.
// =============================================

// Same anon key already shipped in every page's client-side JS and in
// sitemap.mjs - not a secret. RLS (public read) plus the is_visible
// filter below is what actually controls what this can see.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuamZ6ZmRyYW9xcHZ5b3BnbGRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTkzNzAsImV4cCI6MjA5MDI5NTM3MH0.EchviZ7rgkmO7ixtFuwE8aEPMxu590beO_ww-u0wxxc';

const SITE = 'https://nobodyswatching.live';
const DEFAULT_CARD = `${SITE}/og-card.png`;

// Deliberately generous. A false positive costs one Supabase read and
// serves a page that is correct anyway - the body is untouched, only
// the head differs. A false negative means a blank share card, which is
// the bug we are fixing. So err towards matching.
const UNFURLERS = /(bot\b|bot\/|crawler|spider|facebookexternalhit|twitterbot|slackbot|discordbot|telegrambot|whatsapp|linkedinbot|embedly|pinterest|redditbot|applebot|bingbot|googlebot|yandex|baiduspider|duckduckbot|skypeuripreview|vkshare|mastodon|bluesky|opengraph|iframely|snapchat|flipboard|nuzzel|outbrain|quora link preview|tumblr|w3c_validator|preview)/i;

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Bios are user-supplied free text up to 250 chars. Trim to something a
// card will actually show rather than truncate mid-word.
function clamp(text, max) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:!?-]+$/, '') + '...';
}

// Avatar and thumbnail URLs are user-supplied on the profile form, so
// do not put anything that is not a plain https URL into a meta tag.
function safeImage(url) {
    if (typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!/^https:\/\/[^\s"'<>]+$/i.test(trimmed)) return null;
    return trimmed;
}

export default async function handler(request, context) {
    const userAgent = request.headers.get('user-agent') || '';
    if (!UNFURLERS.test(userAgent)) return; // real person: pass straight through

    const requestUrl = new URL(request.url);
    const username = requestUrl.searchParams.get('user');
    if (!username || username.length > 100) return;

    const response = await context.next();
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return response;

    const supabaseUrl = Netlify.env.get('SUPABASE_URL');
    if (!supabaseUrl) {
        console.error('profile-meta: missing SUPABASE_URL');
        return response;
    }

    let profile = null;
    try {
        // Mirrors exactly what streamer.html itself queries: case-insensitive
        // username match, visible profiles only. A hidden profile must not get
        // a nice share card any more than it gets a page.
        const columns = 'username,avatar_url,bio,is_live,live_game,live_thumbnail_url';
        const query = `${supabaseUrl}/rest/v1/profiles`
            + `?username=ilike.${encodeURIComponent(username)}`
            + `&is_visible=is.true`
            + `&select=${columns}`
            + `&limit=1`;

        const result = await fetch(query, {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`
            }
        });

        if (result.ok) {
            const rows = await result.json();
            profile = Array.isArray(rows) && rows.length ? rows[0] : null;
        } else {
            console.error(`profile-meta: Supabase returned ${result.status} for ${username}`);
        }
    } catch (err) {
        console.error('profile-meta: lookup failed:', err.message);
    }

    // No profile, hidden, or the lookup fell over: leave the static
    // fallback tags in place. They are branded, just not personal.
    if (!profile) return response;

    const name = profile.username || username;
    const isLive = profile.is_live === true;

    const title = isLive
        ? `${name} is live now on NobodysWatching.live`
        : `${name} on NobodysWatching.live`;

    let description;
    if (isLive && profile.live_game) {
        description = `Live right now playing ${profile.live_game}.`;
    } else if (isLive) {
        description = 'Live right now.';
    } else {
        description = '';
    }
    if (profile.bio) {
        description = description ? `${description} ${profile.bio}` : profile.bio;
    }
    if (!description) {
        description = `Find ${name} and other small streamers on NobodysWatching.live. No algorithms, no follower counts.`;
    }
    description = clamp(description, 200);

    // Someone live gets their actual stream thumbnail, which is a far better
    // card than an avatar. Everyone else gets their avatar as a square card.
    // Nothing usable falls back to the site card.
    const liveThumb = isLive ? safeImage(profile.live_thumbnail_url) : null;
    const avatar = safeImage(profile.avatar_url);
    const image = liveThumb || avatar || DEFAULT_CARD;
    const cardType = (liveThumb || image === DEFAULT_CARD) ? 'summary_large_image' : 'summary';

    const canonical = `${SITE}/streamer.html?user=${encodeURIComponent(name)}`;

    const tags = [
        `<title>${esc(title)}</title>`,
        `<meta name="description" content="${esc(description)}">`,
        `<link rel="canonical" href="${esc(canonical)}">`,
        `<meta property="og:title" content="${esc(title)}">`,
        `<meta property="og:description" content="${esc(description)}">`,
        `<meta property="og:type" content="profile">`,
        `<meta property="og:site_name" content="NobodysWatching.live">`,
        `<meta property="og:locale" content="en_GB">`,
        `<meta property="og:url" content="${esc(canonical)}">`,
        `<meta property="og:image" content="${esc(image)}">`,
        `<meta property="og:image:alt" content="${esc(name)} on NobodysWatching.live">`,
        `<meta name="twitter:card" content="${cardType}">`,
        `<meta name="twitter:title" content="${esc(title)}">`,
        `<meta name="twitter:description" content="${esc(description)}">`,
        `<meta name="twitter:image" content="${esc(image)}">`
    ];
    if (image === DEFAULT_CARD) {
        tags.push('<meta property="og:image:width" content="1200">');
        tags.push('<meta property="og:image:height" content="630">');
    }

    let html = await response.text();

    // Drop the static fallbacks so there is exactly one of each tag,
    // then insert the personalised set. Scoped to og:* and twitter:*
    // plus the title and description, so nothing else in the head moves.
    html = html
        .replace(/[ \t]*<meta\s+(?:property|name)="(?:og|twitter):[^"]*"[^>]*>\s*\n?/gi, '')
        .replace(/[ \t]*<meta\s+name="description"[^>]*>\s*\n?/gi, '')
        .replace(/[ \t]*<link\s+rel="canonical"[^>]*>\s*\n?/gi, '')
        .replace(/<title>[\s\S]*?<\/title>/i, '');

    const block = '\n    ' + tags.join('\n    ') + '\n';
    html = html.replace(/<\/head>/i, block + '</head>');

    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.delete('content-length'); // body length changed
    // Unfurlers re-fetch often and live status moves; keep it short.
    headers.set('cache-control', 'public, max-age=300');

    return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

export const config = {
    path: '/streamer.html'
};
