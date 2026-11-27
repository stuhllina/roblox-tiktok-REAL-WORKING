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

// ───────── STATE ─────────

const links = new Map();

const status = {
    tiktok: 'connecting',
    since: Date.now(),
    lastError: null
};

let websocketFrames = 0;
let decodedMessages = 0;
let chatMessages = 0;
let giftMessages = 0;

// ───────── COMMENT HANDLER ─────────

async function handleComment(tiktokId, nickname, comment) {
    console.log(
        `[chat] @${tiktokId} commented: ${JSON.stringify(comment)}`
    );

    const raw = extractUsername(comment);

    if (!raw) {
        console.log('[chat] Ignored: invalid username format');
        return { ok: false, reason: 'not a username' };
    }

    const previous = links.get(tiktokId);

    if (
        previous &&
        previous.roblox.toLowerCase() === raw.toLowerCase()
    ) {
        return { ok: false, reason: 'already linked' };
    }

    if (
        previous &&
        Date.now() - previous.at < config.joinCooldownMs
    ) {
        return { ok: false, reason: 'cooldown' };
    }

    console.log(`[chat] Validating Roblox username: ${raw}`);

    const user = await resolveRobloxName(raw);

    if (!user) {
        console.log(`[chat] Roblox user not found: ${raw}`);
        return { ok: false, reason: 'Roblox user not found' };
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

    console.log(
        `[join] SUCCESS: @${tiktokId} -> ${user.name}`
    );

    return { ok: true, event: ev };
}

// ───────── GIFT HANDLER ─────────

function handleGift(
    tiktokId,
    nickname,
    giftName,
    diamondsEach,
    count
) {
    const totalDiamonds =
        Math.max(1, Number(diamondsEach) || 1) *
        Math.max(1, Number(count) || 1);

    const link = links.get(tiktokId);

    const ev = events.push('gift', {
        roblox: link?.roblox ?? null,
        tiktok: tiktokId,
        nickname,
        giftName,
        count,
        diamonds: totalDiamonds,
        tier: giftTier(totalDiamonds)
    });

    console.log(
        `[gift] @${tiktokId}: ${giftName} x${count} ` +
        `(${totalDiamonds} diamonds) -> ` +
        `${link?.roblox ?? 'unlinked'}`
    );

    return ev;
}

// ───────── TIKTOK CONNECTION ─────────

function startTikTok() {
    if (!config.tiktokUsername) {
        console.log('[tiktok] Missing TIKTOK_USERNAME');
        status.tiktok = 'disabled';
        return;
    }

    const conn = new TikTokLiveConnection(
        config.tiktokUsername,
        {
            processInitialData: false,
            enableExtendedGiftInfo: true
        }
    );

    let retryTimer = null;

    function retry(delay) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, delay);
    }

    async function connect() {
        try {
            status.tiktok = 'connecting';

            const state = await conn.connect();

            status.tiktok = 'connected';
            status.since = Date.now();
            status.lastError = null;

            console.log(
                `[tiktok] CONNECTED to @${config.tiktokUsername}`
            );

            console.log(`[tiktok] Room ID: ${state.roomId}`);

        } catch (error) {
            status.tiktok = 'offline';
            status.lastError = error?.message ?? String(error);

            console.error('[tiktok] CONNECTION ERROR:', error);

            retry(15000);
        }
    }

    // WebSocket connection
    conn.on(ControlEvent.WEBSOCKET_CONNECTED, () => {
        console.log('[tiktok] WEBSOCKET CONNECTED');
    });

    // Incoming WebSocket data
    conn.on(ControlEvent.WEBSOCKET_DATA, (data) => {
        websocketFrames++;

        console.log(
            `[diagnostic] WebSocket frame #${websocketFrames}`
        );
    });

    // Decoded TikTok messages
    conn.on(ControlEvent.DECODED_DATA, (method, data) => {
        decodedMessages++;

        console.log(
            `[diagnostic] Decoded message: ${method}`
        );
    });

    // ───────── CHAT EVENTS ─────────

    conn.on(WebcastEvent.CHAT, async (data) => {
        chatMessages++;

        // Modern connector format, with legacy fallbacks.
        const tiktokId =
            data.user?.displayId ??
            data.user?.uniqueId ??
            null;

        const nickname =
            data.user?.nickname ??
            tiktokId ??
            'Unknown';

        const comment =
            data.content ??
            data.comment ??
            '';

        console.log(
            `[chat] EVENT #${chatMessages}`
        );

        console.log(
            `[chat] TikTok handle: ${tiktokId ?? 'MISSING'}`
        );

        console.log(
            `[chat] Comment: ${JSON.stringify(comment)}`
        );

        if (!tiktokId) {
            console.warn(
                '[chat] Missing TikTok displayId and uniqueId'
            );
            return;
        }

        try {
            const result = await handleComment(
                tiktokId,
                nickname,
                comment
            );

            console.log(
                `[chat] RESULT: ${
                    result.ok ? 'SUCCESS' : result.reason
                }`
            );

        } catch (error) {
            console.error(
                '[chat] PROCESSING ERROR:',
                error
            );
        }
    });

    // ───────── GIFT EVENTS ─────────

    conn.on(WebcastEvent.GIFT, (data) => {
        giftMessages++;

        const tiktokId =
            data.user?.displayId ??
            data.user?.uniqueId;

        if (!tiktokId) {
            console.warn('[gift] Missing sender ID');
            return;
        }

        const gift = data.gift;

        if (!gift) {
            console.warn('[gift] Missing gift information');
            return;
        }

        // Wait until a gift streak has finished.
        if (gift.type === 1 && data.repeatEnd !== 1) {
            console.log(
                `[gift] Streak in progress: ${gift.name}`
            );
            return;
        }

        const nickname =
            data.user?.nickname ??
            tiktokId;

        const giftName =
            gift.name ??
            `Gift ${data.giftId}`;

        const diamondsEach =
            data.extendedGiftInfo?.diamondCount ??
            gift.diamondCount ??
            1;

        const count =
            data.repeatCount ??
            1;

        console.log(
            `[gift] EVENT #${giftMessages}: ${giftName}`
        );

        handleGift(
            tiktokId,
            nickname,
            giftName,
            diamondsEach,
            count
        );
    });

    // ───────── CONNECTION EVENTS ─────────

    conn.on(ControlEvent.ERROR, (error) => {
        console.error('[tiktok] ERROR:', error);
    });

    conn.on(ControlEvent.DISCONNECTED, (data) => {
        status.tiktok = 'offline';

        console.warn('[tiktok] DISCONNECTED:', data);

        retry(5000);
    });

    conn.on(WebcastEvent.STREAM_END, () => {
        status.tiktok = 'offline';

        console.log('[tiktok] STREAM ENDED');

        retry(30000);
    });

    // Diagnostics every 15 seconds
    setInterval(() => {
        console.log(
            `[diagnostic] Frames: ${websocketFrames} | ` +
            `Decoded: ${decodedMessages} | ` +
            `Chats: ${chatMessages} | ` +
            `Gifts: ${giftMessages}`
        );
    }, 15000);

    connect();
}

// ───────── HTTP AUTHENTICATION ─────────

function authed(req) {
    const given = Buffer.from(
        String(req.headers['x-runway-secret'] ?? '')
    );

    const expected = Buffer.from(config.secret);

    return (
        given.length === expected.length &&
        expected.length > 0 &&
        timingSafeEqual(given, expected)
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
            throw new Error('Request too large');
        }
    }

    return body ? JSON.parse(body) : {};
}

// ───────── HTTP ROUTES ─────────

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

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

        if (
            req.method === 'GET' &&
            url.pathname === '/events'
        ) {
            const cursor =
                Number(url.searchParams.get('since') ?? 0) || 0;

            return send(res, 200, {
                ...events.since(cursor),
                tiktok: status.tiktok
            });
        }

        if (
            req.method === 'GET' &&
            url.pathname === '/status'
        ) {
            return send(res, 200, {
                ...status,
                links: links.size,
                ...events.stats(),
                channel: config.tiktokUsername
            });
        }

        // Test comment
        if (
            req.method === 'POST' &&
            url.pathname === '/test/comment'
        ) {
            const body = await readJson(req);

            const testId =
                body.tiktok ??
                `tester_${Date.now()}`;

            const result = await handleComment(
                testId,
                testId,
                String(body.comment ?? '')
            );

            return send(res, 200, result);
        }

        // Test gift
        if (
            req.method === 'POST' &&
            url.pathname === '/test/gift'
        ) {
            const body = await readJson(req);

            const ev = handleGift(
                body.tiktok ?? 'tester',
                body.tiktok ?? 'tester',
                body.giftName ?? 'Rose',
                Number(body.diamonds ?? 1),
                Number(body.count ?? 1)
            );

            return send(res, 200, {
                ok: true,
                event: ev
            });
        }

        return send(res, 404, {
            error: 'not found'
        });

    } catch (error) {
        console.error('[http] ERROR:', error);

        return send(res, 400, {
            error: error.message
        });
    }
});

// ───────── START ─────────

server.listen(config.port, () => {
    console.log(
        `[http] Runway relay listening on port ${config.port}`
    );

    console.log(
        `[config] TikTok: ${config.tiktokUsername}`
    );

    console.log('[runway] Relay starting...');

    startTikTok();
});
