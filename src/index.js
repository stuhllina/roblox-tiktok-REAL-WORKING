import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  TikTokLiveConnection,
  WebcastEvent,
  ControlEvent,
} from 'tiktok-live-connector';

import { config } from './config.js';
import * as events from './events.js';
import { extractUsername, giftTier } from './parse.js';
import { resolveRobloxName } from './roblox.js';

// TikTok viewer -> registered Roblox username.
const links = new Map();

const status = {
  tiktok: config.tiktokUsername ? 'connecting' : 'disabled',
  since: Date.now(),
  lastError: null,
};

const DEBUG = process.env.DEBUG_CHAT === 'true';

// --------------------------------------------------
// CHAT: register a viewer's Roblox username
// --------------------------------------------------

async function handleComment(tiktokId, nickname, comment) {
  const raw = extractUsername(String(comment ?? ''));

  if (DEBUG) {
    console.log(
      `[chat] ${tiktokId}: ${JSON.stringify(comment)} -> ${raw ?? 'ignored'}`
    );
  }

  if (!raw) {
    return { ok: false, reason: 'not a username' };
  }

  const previous = links.get(tiktokId);

  if (previous && previous.roblox.toLowerCase() === raw.toLowerCase()) {
    return { ok: false, reason: 'already linked' };
  }

  if (previous && Date.now() - previous.at < config.joinCooldownMs) {
    const wait = Math.ceil(
      (config.joinCooldownMs - (Date.now() - previous.at)) / 1000
    );

    return { ok: false, reason: `cooldown: ${wait}s remaining` };
  }

  const user = await resolveRobloxName(raw);

  if (!user) {
    console.log(`[chat] Invalid Roblox username: ${raw}`);
    return { ok: false, reason: 'no such Roblox user' };
  }

  links.set(tiktokId, {
    roblox: user.name,
    at: Date.now(),
  });

  const event = events.push('join', {
    roblox: user.name,
    robloxId: user.id,
    tiktok: tiktokId,
    nickname,
  });

  console.log(`[join] @${tiktokId} -> ${user.name}`);

  return { ok: true, event };
}

// --------------------------------------------------
// GIFTS: priority and dance events
// --------------------------------------------------

function handleGift(tiktokId, nickname, giftName, diamondsEach, count) {
  const safeCount = Math.max(1, Number(count) || 1);
  const safeDiamonds = Math.max(1, Number(diamondsEach) || 1);

  const diamonds = safeDiamonds * safeCount;
  const tier = giftTier(diamonds);
  const link = links.get(tiktokId);

  const event = events.push('gift', {
    roblox: link?.roblox ?? null,
    tiktok: tiktokId,
    nickname,
    giftName,
    count: safeCount,
    diamonds,
    tier,
  });

  console.log(
    `[gift] @${tiktokId}: ${giftName} x${safeCount} ` +
    `(${diamonds} diamonds, ${tier}) -> ${link?.roblox ?? 'unlinked'}`
  );

  return event;
}

// --------------------------------------------------
// TIKTOK LIVE CONNECTION
// --------------------------------------------------

function startTikTok() {
  if (!config.tiktokUsername) {
    console.log('[tiktok] No username configured. Test mode only.');
    return;
  }

  console.log(`[tiktok] Preparing connection to @${config.tiktokUsername}`);

  const connectionOptions = {
    // Use Euler signing key if one is configured.
    ...(config.eulerKey ? { signApiKey: config.eulerKey } : {}),

    // Important: do not fetch the optional gift catalogue.
    enableExtendedGiftInfo: false,

    // Do not process old messages returned during initial connection.
    processInitialData: false,

    // Fetch room information so the connector can verify the LIVE room.
    fetchRoomInfoOnConnect: true,
  };

  const conn = new TikTokLiveConnection(
    config.tiktokUsername,
    connectionOptions
  );

  let retryTimer = null;
  let connecting = false;
  let stopped = false;

  function scheduleReconnect(delay = 15000) {
    if (stopped || retryTimer) return;

    retryTimer = setTimeout(async () => {
      retryTimer = null;

      try {
        await conn.disconnect();
      } catch {
        // It may already be disconnected.
      }

      connect();
    }, delay);
  }

  async function connect() {
    if (connecting || stopped) return;

    connecting = true;
    status.tiktok = 'connecting';

    try {
      console.log(`[tiktok] Connecting to @${config.tiktokUsername}...`);

      const state = await conn.connect();

      status.tiktok = 'connected';
      status.since = Date.now();
      status.lastError = null;

      console.log(
        `[tiktok] CONNECTED to @${config.tiktokUsername} ` +
        `(room ${state?.roomId ?? 'unknown'})`
      );
    } catch (error) {
      status.tiktok = 'offline';
      status.lastError = error?.message ?? String(error);

      console.error('[tiktok] CONNECTION FAILED:', status.lastError);

      scheduleReconnect(15000);
    } finally {
      connecting = false;
    }
  }

  // Connection lifecycle events.
  if (ControlEvent.WEBSOCKET_CONNECTED) {
    conn.on(ControlEvent.WEBSOCKET_CONNECTED, () => {
      console.log('[tiktok] WEBSOCKET CONNECTED');
    });
  }

  if (ControlEvent.DISCONNECTED) {
    conn.on(ControlEvent.DISCONNECTED, () => {
      console.warn('[tiktok] Disconnected from TikTok');

      status.tiktok = 'offline';

      scheduleReconnect(5000);
    });
  }

  if (ControlEvent.ERROR) {
    conn.on(ControlEvent.ERROR, (error = {}) => {
      const message =
        error.exception?.message ??
        error.info ??
        error.message ??
        'Unknown connector error';

      console.error('[tiktok] ERROR:', message);
      status.lastError = String(message);
    });
  }

  // ------------------------------------------------
  // CHAT EVENTS - modern connector payload
  // ------------------------------------------------

  conn.on(WebcastEvent.CHAT, (data) => {
    const tiktokId = data.user?.displayId;
    const nickname = data.user?.nickname ?? tiktokId;
    const comment = data.content;

    if (!tiktokId || !comment) return;

    console.log(`[chat] @${tiktokId}: ${comment}`);

    handleComment(tiktokId, nickname, comment).catch((error) => {
      console.error('[chat] Processing error:', error.message);
    });
  });

  // ------------------------------------------------
  // GIFT EVENTS - modern connector payload
  // ------------------------------------------------

  conn.on(WebcastEvent.GIFT, (data) => {
    const tiktokId = data.user?.displayId;
    const nickname = data.user?.nickname ?? tiktokId;

    if (!tiktokId) return;

    const gift = data.gift ?? {};

    // Only process a streakable gift once, at the end of its streak.
    if (gift.type === 1 && data.repeatEnd !== 1) {
      return;
    }

    const giftName =
      gift.name ??
      `Gift ${data.giftId ?? 'unknown'}`;

    const diamondsEach =
      Number(gift.diamondCount) || 1;

    const count =
      Number(data.repeatCount) || 1;

    handleGift(
      tiktokId,
      nickname,
      giftName,
      diamondsEach,
      count
    );
  });

  // ------------------------------------------------
  // STREAM END
  // ------------------------------------------------

  conn.on(WebcastEvent.STREAM_END, () => {
    console.log('[tiktok] Stream ended');

    status.tiktok = 'offline';

    scheduleReconnect(30000);
  });

  connect();
}

// --------------------------------------------------
// HTTP API
// --------------------------------------------------

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
    'content-type': 'application/json',
  });

  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 10000) {
      throw new Error('Request body too large');
    }
  }

  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    // Public health check.
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        tiktok: status.tiktok,
      });
    }

    // Everything below requires the shared secret.
    if (!authed(req)) {
      return send(res, 401, {
        error: 'unauthorized',
      });
    }

    // Roblox polls this endpoint for new events.
    if (req.method === 'GET' && url.pathname === '/events') {
      const cursor =
        Number(url.searchParams.get('since') ?? 0) || 0;

      return send(res, 200, {
        ...events.since(cursor),
        tiktok: status.tiktok,
      });
    }

    // Connection and queue status.
    if (req.method === 'GET' && url.pathname === '/status') {
      return send(res, 200, {
        ...status,
        links: links.size,
        ...events.stats(),
        channel: config.tiktokUsername || null,
      });
    }

    // Test a comment without going LIVE.
    if (req.method === 'POST' && url.pathname === '/test/comment') {
      const body = await readJson(req);

      const tiktokId =
        body.tiktok ?? `tester_${Date.now()}`;

      const result = await handleComment(
        tiktokId,
        body.tiktok ?? 'tester',
        String(body.comment ?? '')
      );

      return send(res, 200, result);
    }

    // Test a gift without going LIVE.
    if (req.method === 'POST' && url.pathname === '/test/gift') {
      const body = await readJson(req);

      const event = handleGift(
        body.tiktok ?? 'tester',
        body.tiktok ?? 'tester',
        body.giftName ?? 'Rose',
        Number(body.diamonds ?? 1),
        Number(body.count ?? 1)
      );

      return send(res, 200, {
        ok: true,
        event,
      });
    }

    return send(res, 404, {
      error: 'not found',
    });
  } catch (error) {
    console.error('[http] Request error:', error);

    return send(res, 400, {
      error: error.message,
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

server.listen(config.port, () => {
  console.log(`[http] Runway relay listening on port ${config.port}`);

  console.log(
    `[config] commentMode=${config.commentMode} ` +
    `validateNames=${config.validateNames} ` +
    `debugChat=${DEBUG}`
  );

  startTikTok();
});
