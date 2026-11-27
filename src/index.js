import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
    TikTokLiveConnection,
    WebcastEvent,
    ControlEvent
} from 'tiktok-live-connector';

import { config } from './config.js';
import * as events from './events.js';
import { extractUsername, giftTier } from './parse.js';
import { resolveRobloxName } from './roblox.js';

// TikTok viewer -> registered Roblox username
const links = new Map();

const status = {
    tiktok: config.tiktokUsername ? 'connecting' : 'disabled',
    since: Date.now(),
    lastError: null
};

const DEBUG = (process.env.DEBUG_CHAT ?? 'true').trim() === 'true';

// ───────── COMMENT HANDLER ─────────

async function handleComment(tiktokId, nickname, comment) {
    console.log(`[chat] Received from @${tiktokId}: ${JSON.stringify(comment)}`);

    const raw = extractUsername(comment);

    if (!raw) {
        console.log('[chat] Ignored: comment did not match username format');
        return { ok: false, reason: 'not a username' };
    }

    const prev = links.get(tiktokId);

    if (prev && prev.roblox.toLowerCase() === raw.toLowerCase()) {
        console.log(`[chat] Already linked to ${raw}`);
        return { ok: false, reason: 'already linked' };
    }

    if (prev && Date.now() - prev.at < config.joinCooldownMs) {
        const wait = Math.ceil(
            (config.joinCooldownMs - (Date.now() - prev.at)) / 1000
        );

        console.log(`[chat] Cooldown: ${wait}s remaining`);
        return { ok: false, reason: 'cooldown' };
    }

    console.log(`[chat] Checking Roblox username: ${raw}`);

    const user = await resolveRobloxName(raw);

    if (!user) {
        console.log(`[chat] Roblox username not found: ${raw}`);
        return { ok: false, reason: 'no such Roblox user' };
    }

    links.set(tiktokId, {
        roblox: user.name,
        at: Date.now()
    });

    const ev = events.push('join', {
        roblox: user.name,
        robloxId: user.id,
        tiktok: tiktokId,
        nickname
    });

    console.log(`[join] SUCCESS: @${tiktokId} -> ${user.name}`);

    return { ok: true, event: ev };
}

// ───────── GIFT HANDLER ─────────

function handleGift(tiktokId, nickname, giftName, diamondsEach, count) {
    const diamonds = Math.max(1, diamondsEach) * Math.max(1, count);
    const tier = giftTier(diamonds);
    const link = links.get(tiktokId);

    const ev = events.push('gift', {
        roblox: link?.roblox ?? null,
        tiktok: tiktokId,
        nickname,
        giftName,
        count,
        diamonds,
        tier
    });

    console.log(
        `[gift] @${tiktokId}: ${giftName} x${count} ` +
        `(${diamonds} diamonds) -> ${link?.roblox ?? 'unlinked'}`
    );

    return ev;
}

// ───────── TIKTOK CONNECTION ─────────

function startTikTok() {
    if (!config.tiktokUsername) {
        console.log('[tiktok] TIKTOK_USERNAME missing - test-only mode');
        return;
    }

    const conn = new TikTokLiveConnection(config.tiktokUsername, {
        ...(config.eulerKey ? { signApiKey: config.eulerKey } : {}),
        enableExtendedGiftInfo: false,
        processInitialData: false
    });

    let retryTimer = null;

    let websocketFrames = 0;
    let decodedMessages = 0;
    let chatMessages = 0;
    let giftMessages = 0;

    const retry = (delay) => {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, delay);
    };

    async function connect() {
        status.tiktok = 'connecting';

        try {
            const state = await conn.connect();

            status.tiktok = 'connected';
            status.since = Date.now();
            status.lastError = null;

            console.log(
                `[tiktok] CONNECTED to @${config.tiktokUsername}`
            );

            console.log(`[tiktok] Room ID: ${state.roomId}`);

            const info = conn.roomInfo ?? state;

            const viewers =
                info?.viewer_count ??
                info?.viewerCount ??
                info?.stats?.viewer_count ??
                info?.stats?.viewerCount ??
                'unknown';

            console.log(`[tiktok] Viewers: ${viewers}`);

        } catch (err) {
            status.tiktok = 'offline';
            status.lastError = err?.message ?? String(err);

            console.warn('[tiktok] CONNECTION FAILED:', status.lastError);

            retry(15000);
        }
    }

    // WebSocket connection established
    conn.on(ControlEvent.WEBSOCKET_CONNECTED, () => {
        console.log('[tiktok] WEBSOCKET CONNECTED');
    });

    // Actual incoming WebSocket frames
    conn.on(ControlEvent.WEBSOCKET_DATA, (data) => {
        websocketFrames++;

        console.log(
            `[tiktok] WEBSOCKET FRAME #${websocketFrames}: ` +
            `${data?.byteLength ?? data?.length ?? 0} bytes`
        );
    });

    // Successfully decoded messages
    conn.on(ControlEvent.DECODED_DATA, (method, decoded) => {
        decodedMessages++;

        console.log(`[tiktok] DECODED MESSAGE: ${method}`);

        if (method === 'WebcastChatMessage') {
            console.log('[tiktok] CHAT MESSAGE DECODED');
        }
    });

    // Chat comments
    conn.on(WebcastEvent.CHAT, async (data) => {
        chatMessages++;

        const id = data.user?.uniqueId;
        const nickname = data.user?.nickname ?? id ?? 'unknown';
        const comment = data.comment ?? '';

        console.log(
            `[chat] EVENT #${chatMessages}: ` +
            `@${id ?? 'unknown'}: ${JSON.stringify(comment)}`
        );

        if (!id) {
            console.warn('[chat] Missing TikTok user ID');
            return;
        }

        try {
            const result = await handleComment(id, nickname, comment);

            console.log(
                `[chat] RESULT for @${id}:`,
                result.ok ? 'SUCCESS' : result.reason
            );
        } catch (err) {
            console.warn('[chat] PROCESSING ERROR:', err.message);
        }
    });

    // Gifts
    conn.on(WebcastEvent.GIFT, (data) => {
        giftMessages++;

        const details = data.giftDetails ?? {};

        if (details.giftType === 1 && !data.repeatEnd) {
            return;
        }

        const id = data.user?.uniqueId;

        if (!id) return;

        console.log(`[gift] EVENT #${giftMessages}`);

        handleGift(
            id,
            data.user?.nickname ?? id,
            details.giftName ?? `gift ${data.giftId}`,
            details.diamondCount ?? 1,
            data.repeatCount ?? 1
        );
    });

    // Diagnostic heartbeat
    setInterval(() => {
        if (status.tiktok !== 'connected') return;

        console.log(
            `[diagnostic] Frames: ${websocketFrames} | ` +
            `Decoded: ${decodedMessages} | ` +
            `Chats: ${chatMessages} | ` +
            `Gifts: ${giftMessages}`
        );
    }, 15000);

    conn.on(WebcastEvent.STREAM_END, () => {
        status.tiktok = 'offline';

        console.log('[tiktok] STREAM ENDED');

        retry(30000);
    });

    conn.on(ControlEvent.DISCONNECTED, (data) => {
        if (status.tiktok === 'connected') {
            status.tiktok = 'offline';

            console.warn('[tiktok] DISCONNECTED:', data);

            retry(5000);
        }
    });

    conn.on(ControlEvent.ERROR, (error) => {
        console.warn('[tiktok] ERROR:', error);
    });

    connect();
}

// ───────── HTTP API ─────────

function authed(req) {
    const given = Buffer.from(
        String(req.headers['x-runway-secret'] ?? '')
    );

    const want = Buffer.from(config.secret);

    return (
        given.length === want.length &&
        want.length > 0 &&
        timingSafeEqual(given, want)
    );
}

function send(res, code, body) {
    res.writeHead(code, {
        'content-type': 'application/json'
    });

    res.end(JSON.stringify(body));
}

async function readJson(req) {
    let body = '';

    for await (const chunk of req) {
        body += chunk;

        if (body.length > 10000) {
            throw new Error('body too large');
        }
    }

    return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    try {
        if (url.pathname === '/health') {
            return send(res, 200, {
                ok: true,
                tiktok: status.tiktok
            });
        }

        if (!authed(req)) {
            return send(res, 401, {
                error: 'unauthorized'
            });
        }

        if (req.method === 'GET' && url.pathname === '/events') {
            const cursor =
                Number(url.searchParams.get('since') ?? 0) || 0;

            return send(res, 200, {
                ...events.since(cursor),
                tiktok: status.tiktok
            });
        }

        if (req.method === 'GET' && url.pathname === '/status') {
            return send(res, 200, {
                ...status,
                links: links.size,
                ...events.stats(),
                channel: config.tiktokUsername || null
            });
        }

        // Test comments without TikTok LIVE
        if (req.method === 'POST' && url.pathname === '/test/comment') {
            const b = await readJson(req);

            const r = await handleComment(
                b.tiktok ?? `tester_${Math.random().toString(36).slice(2, 7)}`,
                b.tiktok ?? 'tester',
                String(b.comment ?? '')
            );

            return send(res, 200, r);
        }

        // Test gifts without TikTok LIVE
        if (req.method === 'POST' && url.pathname === '/test/gift') {
            const b = await readJson(req);

            const ev = handleGift(
                b.tiktok ?? 'tester',
                b.tiktok ?? 'tester',
                b.giftName ?? 'Rose',
                Number(b.diamonds ?? 1),
                Number(b.count ?? 1)
            );

            return send(res, 200, {
                ok: true,
                event: ev
            });
        }

        return send(res, 404, {
            error: 'not found'
        });

    } catch (err) {
        return send(res, 400, {
            error: err.message
        });
    }
});

// ───────── START SERVER ─────────

server.listen(config.port, () => {
    console.log(`[http] Runway relay listening on :${config.port}`);

    console.log(
        `[config] commentMode=${config.commentMode}` +
        (config.commentMode === 'prefix'
            ? ` prefix="${config.commentPrefix}"`
            : '') +
        ` validateNames=${config.validateNames}`
    );

    startTikTok();
});
