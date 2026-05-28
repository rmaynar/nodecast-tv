const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');
const { sources, settings } = require('../db');
const { getDb } = require('../db/sqlite');

/**
 * Sanitize a string for use as a filename.
 * Strips control characters and characters illegal on Windows,
 * collapses whitespace, trims, and caps at 200 chars.
 * Falls back to `fallback` if the result is empty.
 */
function sanitizeFilename(name, fallback) {
    const cleaned = String(name || '')
        .replace(/[\x00-\x1f\x7f]/g, '')      // strip control chars
        .replace(/[<>:"/\\|?*]/g, '_')          // illegal on Windows
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
    return cleaned || fallback;
}

/**
 * Resolve the upstream URL for the requested item.
 *
 * For Xtream sources:
 *   <baseUrl>/<type>/<username>/<password>/<itemId>.<container>
 *
 * For M3U sources:
 *   Look up stream_url from playlist_items by composite id `${sourceId}:${itemId}`.
 *   Returns null if the row is missing or has no URL (caller sends 404).
 */
function resolveUpstreamUrl(source, type, itemId, container) {
    if (source.type === 'xtream') {
        const baseUrl = source.url.replace(/\/$/, '');
        return `${baseUrl}/${type}/${source.username}/${source.password}/${itemId}.${container}`;
    }

    // M3U source — look up in SQLite
    const db = getDb();
    const row = db.prepare(
        `SELECT stream_url FROM playlist_items WHERE source_id = ? AND item_id = ? LIMIT 1`
    ).get(source.id, String(itemId));

    if (!row || !row.stream_url) {
        return null;
    }
    return row.stream_url;
}

/**
 * Download endpoint — streams the upstream file as a forced browser download.
 *
 * GET /api/download/:sourceId/:type/:itemId
 *
 * Query params:
 *   container  (string)  File extension / container format. Default: "mp4"
 *   name       (string)  Desired filename without extension. Default: "<type>-<itemId>"
 *
 * Gate: settings.allow_downloads must be true; otherwise 403.
 * Supports HTTP Range requests for partial content / resume.
 */
router.get('/:sourceId/:type/:itemId', async (req, res) => {
    try {
        // --- Settings gate ---
        const current = await settings.get();
        if (current.allow_downloads !== true) {
            return res.status(403).json({ error: 'Downloads are disabled' });
        }

        // --- Validate :type ---
        const { sourceId, type, itemId } = req.params;
        if (type === 'live') {
            return res.status(400).json({ error: 'Live streams are not downloadable' });
        }
        if (type !== 'movie' && type !== 'series') {
            return res.status(400).json({ error: 'Invalid type. Must be "movie" or "series".' });
        }

        // --- Query params ---
        const container = (req.query.container || 'mp4').replace(/^\./, '');
        const rawName = req.query.name || `${type}-${itemId}`;
        const safeName = sanitizeFilename(rawName, `${type}-${itemId}`);
        const encodedName = encodeURIComponent(safeName);
        const disposition =
            `attachment; filename="${safeName}.${container}"; ` +
            `filename*=UTF-8''${encodedName}.${container}`;

        // --- Load source ---
        const source = await sources.getById(sourceId);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // --- Resolve upstream URL ---
        const upstreamUrl = resolveUpstreamUrl(source, type, itemId, container);
        if (!upstreamUrl) {
            return res.status(404).json({ error: 'Stream URL not found for this item' });
        }

        // --- Forward Range header if present ---
        const requestHeaders = {
            'User-Agent': 'Mozilla/5.0'
        };
        const rangeHeader = req.get('Range');
        if (rangeHeader) {
            requestHeaders['Range'] = rangeHeader;
        }

        // --- Make upstream request, following redirects (Xtream providers commonly 302) ---
        let activeUpstreamReq = null;
        let aborted = false;

        function fetchUpstream(targetUrl, redirectsLeft, onResponse) {
            const urlObj = new URL(targetUrl);
            const client = urlObj.protocol === 'https:' ? https : http;
            const r = client.get(targetUrl, { headers: requestHeaders }, (upstreamRes) => {
                const status = upstreamRes.statusCode;

                if ([301, 302, 303, 307, 308].includes(status)) {
                    const location = upstreamRes.headers.location;
                    upstreamRes.resume();
                    if (!location || redirectsLeft <= 0) {
                        if (!res.headersSent) {
                            res.status(502).json({ error: `Upstream redirect loop or missing Location` });
                        }
                        return;
                    }
                    const next = new URL(location, targetUrl).toString();
                    fetchUpstream(next, redirectsLeft - 1, onResponse);
                    return;
                }
                onResponse(upstreamRes);
            });
            r.on('error', (err) => {
                if (aborted) return;
                console.error('[Download] Upstream request error:', err.message);
                if (!res.headersSent) {
                    res.status(502).json({ error: 'Upstream fetch failed' });
                } else {
                    res.destroy();
                }
            });
            r.setTimeout(30000, () => {
                r.destroy();
                if (!res.headersSent) {
                    res.status(502).json({ error: 'Upstream fetch timed out' });
                } else {
                    res.destroy();
                }
            });
            activeUpstreamReq = r;
            return r;
        }

        const upstreamReq = fetchUpstream(upstreamUrl, 5, (upstreamRes) => {
            const upstreamStatus = upstreamRes.statusCode;

            // Non-2xx upstream response
            if (upstreamStatus !== 200 && upstreamStatus !== 206) {
                if (!res.headersSent) {
                    res.status(502).json({ error: `Upstream returned ${upstreamStatus}` });
                }
                upstreamRes.resume(); // drain the response
                return;
            }

            // --- Build response headers ---
            const contentType = upstreamRes.headers['content-type'] || 'application/octet-stream';
            const contentLength = upstreamRes.headers['content-length'];
            const contentRange = upstreamRes.headers['content-range'];
            const acceptRanges = upstreamRes.headers['accept-ranges'];

            res.setHeader('Content-Disposition', disposition);
            res.setHeader('Content-Type', contentType);

            if (contentLength) {
                res.setHeader('Content-Length', contentLength);
            }
            if (contentRange) {
                res.setHeader('Content-Range', contentRange);
            }
            res.setHeader('Accept-Ranges', acceptRanges || 'bytes');

            // Honour partial content from upstream
            res.statusCode = upstreamStatus === 206 ? 206 : 200;

            // --- Stream / pipe ---
            upstreamRes.pipe(res);

            upstreamRes.on('error', (err) => {
                console.error('[Download] Upstream response error:', err.message);
                if (!res.headersSent) {
                    res.status(502).json({ error: 'Upstream fetch failed' });
                } else {
                    res.destroy();
                }
            });
        });

        // If the client disconnects, abort whatever upstream request is in flight
        req.on('close', () => {
            aborted = true;
            if (activeUpstreamReq) activeUpstreamReq.destroy();
        });

    } catch (err) {
        console.error('[Download] Error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
});

module.exports = router;
