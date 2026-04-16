"use strict";

/**
 * apiModernizer — makes Kami use /includes scripts instead of the
 * library's built-in implementations.
 *
 * Wraps the raw FCA api object after login and replaces four methods:
 *
 *  api.sendMessage   — rate-limiting queue (max concurrency + sliding
 *                      window), anti-suspension prep, human typing, and
 *                      auth-error detection that feeds _triggerAutoRelogin.
 *
 *  api.getThreadInfo — in-memory + disk cache so the bot never hits FB
 *                      twice for the same thread.
 *
 *  api.getUserInfo   — same cache logic for user lookups.
 *
 *  api.listenMqtt    — MQTT auto-reconnect with exponential backoff on
 *                      non-auth errors, feeding _restartListener.
 *
 * Additional features:
 *  - Circuit-breaker controls on global.nkx
 *  - Warmup mode (via antiSuspension)
 *  - Health broadcast (logs queue depth + MQTT status)
 *  - Periodic fb_dtsg refresh
 *  - Cache flush to disk every 2 minutes
 */

const fs   = require("fs-extra");
const path = require("path");

function _makeLog() {
  return function log(msg, color) {
    try {
      if (global.loggeryuki) {
        global.loggeryuki.log([
          { message: "[ MODERNIZER ]: ", color: ["red", "cyan"] },
          { message: msg, color: color || "white" }
        ]);
        return;
      }
    } catch (_) {}
    console.log("[MODERNIZER]", msg);
  };
}

function _getCfg() {
  const cfg = global.config?.nkxModern || {};
  return {
    enabled:                cfg.enabled              !== false,
    enableHealthBroadcast:  cfg.enableHealthBroadcast !== false,
    healthBroadcastMinutes: cfg.healthBroadcastMinutes || 15,
    enableWarmup:           cfg.enableWarmup          !== false,
    warmupMinutes:          cfg.warmupMinutes          || 20,
    enableCircuitBreaker:   cfg.enableCircuitBreaker   !== false,
    enableTypingWrap:       cfg.enableTypingWrap        !== false,
    maxSendConcurrency:     cfg.maxSendConcurrency      || 4,
    sendWindowMs:           cfg.sendWindowMs            || 60000,
    sendWindowLimit:        cfg.sendWindowLimit          || 45,
    cacheFile:              cfg.cacheFile               || "cache/kami-cache.json"
  };
}

function _toCallbackStyle(promise, cb) {
  if (typeof cb !== "function") return promise;
  promise.then(res => cb(null, res)).catch(err => cb(err));
}

function _classifyAuthError(errLike) {
  const str = String(
    (errLike && (errLike.error || errLike.message || errLike.reason)) || errLike || ""
  ).toLowerCase();
  return [
    "checkpoint", "login", "session expired", "not-authorized",
    "auth", "cookie", "invalid token", "account"
  ].some(k => str.includes(k));
}

/**
 * Modernize a raw FCA api instance.
 * Idempotent — safe to call again after a tier switch.
 *
 * @param {object} api  Raw FCA API
 * @returns {object}    Same reference, patched in-place
 */
module.exports = function modernizeApi(api) {
  if (!api || api.__kamiModernized) return api;

  const log = _makeLog();
  const cfg = _getCfg();

  // ── Apply cookie patcher first (safety net) ───────────────────────────────
  if (!api.__zaoCookiePatched) {
    try {
      const { patchCookieApi } = require("./zaoCookiePatcher");
      patchCookieApi(api, {
        tier:        global.activeAccountTier || 1,
        stateFile:   global.activeStateFile   || "appstate.json",
        loginMethod: "appstate"
      });
    } catch (e) {
      log("Cookie patcher unavailable: " + (e.message || e), "yellow");
    }
  }

  if (!cfg.enabled) return api;

  // ── Timer registry (for clean shutdown) ───────────────────────────────────
  const timers = [];
  const safeTimer = {
    setInterval(fn, ms) { const t = setInterval(fn, ms); timers.push(t); return t; },
    setTimeout(fn, ms)  { const t = setTimeout(fn, ms);  timers.push(t); return t; }
  };

  // ── Rate-limiting state ───────────────────────────────────────────────────
  const rate = { starts: [], active: 0, queue: [] };

  function _trimWindow(now) {
    const min = now - cfg.sendWindowMs;
    while (rate.starts.length && rate.starts[0] < min) rate.starts.shift();
  }

  function _jitter() { return Math.floor(Math.random() * 300) + 80; }

  function _pump() {
    if (!rate.queue.length) return;
    if (rate.active >= cfg.maxSendConcurrency) return;
    const now = Date.now();
    _trimWindow(now);
    if (rate.starts.length >= cfg.sendWindowLimit) {
      safeTimer.setTimeout(_pump, 400 + _jitter());
      return;
    }
    const item = rate.queue.shift();
    rate.active++;
    rate.starts.push(now);
    Promise.resolve()
      .then(item.run)
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        rate.active--;
        safeTimer.setTimeout(_pump, _jitter());
      });
  }

  function _enqueue(run) {
    return new Promise((resolve, reject) => {
      rate.queue.push({ run, resolve, reject });
      _pump();
    });
  }

  // ── Thread / user cache ───────────────────────────────────────────────────
  const cache = { threads: new Map(), users: new Map(), dirty: false };
  const cachePath = path.join(process.cwd(), cfg.cacheFile);

  try {
    if (fs.existsSync(cachePath)) {
      const data = fs.readJsonSync(cachePath);
      for (const [k, v] of Object.entries(data.threads || {})) cache.threads.set(k, v);
      for (const [k, v] of Object.entries(data.users  || {})) cache.users.set(k, v);
      log(`Cache restored (${cache.threads.size} threads, ${cache.users.size} users) ✓`);
    }
  } catch (e) {
    log("Cache restore skipped: " + (e.message || e), "yellow");
  }

  async function _flushCache() {
    if (!cache.dirty) return;
    try {
      await fs.ensureDir(path.dirname(cachePath));
      await fs.writeJson(
        cachePath,
        { threads: Object.fromEntries(cache.threads), users: Object.fromEntries(cache.users) },
        { spaces: 2 }
      );
      cache.dirty = false;
    } catch (e) {
      log("Cache flush failed: " + (e.message || e), "yellow");
    }
  }

  safeTimer.setInterval(_flushCache, 120000);

  // ── Load /includes helpers ────────────────────────────────────────────────
  const typing = (() => {
    try { return require("./humanTyping"); } catch (_) { return null; }
  })();

  const antiSusp = (() => {
    try { return require("./antiSuspension").globalAntiSuspension; } catch (_) { return null; }
  })();

  // ── Save originals before patching ───────────────────────────────────────
  const orig = {
    sendMessage:   typeof api.sendMessage   === "function" ? api.sendMessage.bind(api)   : null,
    listenMqtt:    typeof api.listenMqtt    === "function" ? api.listenMqtt.bind(api)     : null,
    getThreadInfo: typeof api.getThreadInfo === "function" ? api.getThreadInfo.bind(api)  : null,
    getUserInfo:   typeof api.getUserInfo   === "function" ? api.getUserInfo.bind(api)    : null
  };

  // ── 1. sendMessage — rate-limit + anti-suspension + typing ───────────────
  if (orig.sendMessage) {
    api.sendMessage = function kamiSendMessage(form, threadID, callback, replyToMessage) {
      const run = async () => {
        // Anti-suspension pre-flight
        if (antiSusp) {
          try { await antiSusp.prepareBeforeMessage(threadID, form); } catch (_) {}
        }
        // Human typing via /includes/humanTyping.js (not the library's version)
        if (cfg.enableTypingWrap && typing) {
          const d = typing.calcDelay(form);
          if (d > 0) await typing.simulateTyping(api, threadID, d);
        }
        return new Promise((resolve, reject) => {
          orig.sendMessage(form, threadID, (err, info) => {
            if (err) {
              if (antiSusp) {
                try { antiSusp.checkAccountHealth(err); } catch (_) {}
              }
              if (_classifyAuthError(err) && typeof global._triggerAutoRelogin === "function") {
                global._triggerAutoRelogin(err);
              }
              return reject(err);
            }
            resolve(info);
          }, replyToMessage);
        });
      };

      const p = _enqueue(run);
      if (typeof callback === "function") {
        p.then(info => callback(null, info)).catch(err => callback(err));
        return;
      }
      return p;
    };
    log("sendMessage patched (rate-limit + anti-susp + typing) ✓");
  }

  // ── 2. getThreadInfo — cached via /includes/ cache ───────────────────────
  if (orig.getThreadInfo) {
    api.getThreadInfo = function kamiGetThreadInfo(threadID, callback) {
      const key      = String(threadID);
      const fromCache = cache.threads.get(key);
      if (fromCache) return _toCallbackStyle(Promise.resolve(fromCache), callback);
      const p = Promise.resolve(orig.getThreadInfo(threadID)).then(info => {
        if (info) { cache.threads.set(key, info); cache.dirty = true; }
        return info;
      });
      return _toCallbackStyle(p, callback);
    };
    log("getThreadInfo patched (in-memory cache) ✓");
  }

  // ── 3. getUserInfo — cached via /includes/ cache ─────────────────────────
  if (orig.getUserInfo) {
    api.getUserInfo = function kamiGetUserInfo(userID, callback) {
      const key       = String(userID);
      const fromCache = cache.users.get(key);
      if (fromCache) return _toCallbackStyle(Promise.resolve({ [key]: fromCache }), callback);
      const p = Promise.resolve(orig.getUserInfo(userID)).then(info => {
        const data = info && info[key] ? info[key] : null;
        if (data) { cache.users.set(key, data); cache.dirty = true; }
        return info;
      });
      return _toCallbackStyle(p, callback);
    };
    log("getUserInfo patched (in-memory cache) ✓");
  }

  // ── 4. listenMqtt — MQTT auto-reconnect with exponential backoff ──────────
  if (orig.listenMqtt) {
    let attempts = 0;
    api.listenMqtt = function kamiListenMqtt(handler) {
      const wrapped = (err, event) => {
        if (!err) {
          attempts = 0;
          global.lastMqttActivity = Date.now();
          return handler(err, event);
        }
        const isAuth = _classifyAuthError(err);
        if (isAuth && typeof global._triggerAutoRelogin === "function") {
          global._triggerAutoRelogin(err);
        }
        if (!isAuth && typeof global._restartListener === "function") {
          attempts++;
          const backoff = Math.min(45000, (2 ** Math.min(attempts, 6)) * 500 + Math.floor(Math.random() * 1000));
          log(`MQTT error — reconnecting in ${Math.round(backoff / 1000)}s (attempt ${attempts})`, "yellow");
          safeTimer.setTimeout(() => {
            try { global._restartListener(); } catch (_) {}
          }, backoff);
        }
        return handler(err, event);
      };
      return orig.listenMqtt(wrapped);
    };
    log("listenMqtt patched (auto-reconnect with backoff) ✓");
  }

  // ── Circuit-breaker controls on global.nkx ────────────────────────────────
  if (cfg.enableCircuitBreaker && antiSusp) {
    global.nkx = global.nkx || {};
    global.nkx.tripCircuit  = (reason, ms) => antiSusp.tripCircuitBreaker(reason || "manual", ms || 30 * 60 * 1000);
    global.nkx.resetCircuit = ()           => antiSusp.resetCircuitBreaker();
    global.nkx.getCircuit   = ()           => antiSusp.getConfig();
    log("Circuit-breaker controls on global.nkx ✓");
  }

  // ── Warmup mode ───────────────────────────────────────────────────────────
  if (cfg.enableWarmup && antiSusp) {
    try {
      antiSusp.enableWarmup();
      log(`Warmup mode enabled for ${cfg.warmupMinutes} min ✓`, "green");
    } catch (_) {}
  }

  // ── Health broadcast ───────────────────────────────────────────────────────
  if (cfg.enableHealthBroadcast) {
    safeTimer.setInterval(() => {
      try {
        let mqttOk = "?";
        if (typeof api.getHealthStatus === "function") {
          const h = api.getHealthStatus();
          mqttOk = String(h?.mqtt?.isConnected ?? h?.mqttConnected ?? "?");
        }
        log(`Health — mqtt=${mqttOk} queue=${rate.queue.length} active=${rate.active} threads-cached=${cache.threads.size}`);
        global.nkx = global.nkx || {};
        global.nkx.queueDepth  = rate.queue.length;
        global.nkx.activeSlots = rate.active;
      } catch (_) {}
    }, cfg.healthBroadcastMinutes * 60 * 1000);
  }

  // ── Periodic fb_dtsg refresh ───────────────────────────────────────────────
  if (typeof api.refreshFb_dtsg === "function") {
    safeTimer.setInterval(async () => {
      try { await api.refreshFb_dtsg(); } catch (_) {}
    }, (45 + Math.floor(Math.random() * 30)) * 60 * 1000);
    log("fb_dtsg auto-refresh enabled ✓");
  }

  // ── Cleanup hook ──────────────────────────────────────────────────────────
  api.__kamiModernized = true;
  api.__kamiModernizerStop = async function stop() {
    for (const t of timers) { try { clearInterval(t); clearTimeout(t); } catch (_) {} }
    await _flushCache();
  };

  log("API modernizer active — all /includes systems wired ✓", "green");
  return api;
};
