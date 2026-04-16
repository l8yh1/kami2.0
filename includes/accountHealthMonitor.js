"use strict";

/**
 * AccountHealthMonitor
 * =====================
 * Two independent health signals are watched simultaneously:
 *
 * 1. PERIODIC COOKIE SCAN — every 5 minutes, the live session cookie is
 *    validated against Facebook. A confirmed-dead response triggers
 *    forceTierSwitch() (which handles tier advancement).
 *
 * 2. SEND-FAILURE WATCHDOG — every api.sendMessage call that returns an
 *    error is classified:
 *      • Auth / session errors  → already handled by apiModernizer +
 *        _triggerAutoRelogin. Ignored here to avoid double-firing.
 *      • Blocked / generic send errors → counted in a sliding window.
 *        After SEND_FAIL_THRESHOLD failures within SEND_FAIL_WINDOW_MS,
 *        forceTierSwitch() is called.
 *
 * Wraps api.sendMessage once (idempotent guard), safe to call after
 * a tier switch or hot-reload.
 */

const checkLiveCookie = require("./checkLiveCookie");
const { forceTierSwitch } = require("./tierSwitch");

const CHECK_INTERVAL_MS   = 5  * 60 * 1000;
const SEND_FAIL_THRESHOLD = 3;
const SEND_FAIL_WINDOW_MS = 5  * 60 * 1000;
const SWITCH_COOLDOWN_MS  = 3  * 60 * 1000;

const AUTH_KEYWORDS = [
  "checkpoint", "login", "session expired", "not-authorized",
  "auth", "cookie", "invalid token", "account"
];

const SEND_BLOCKED_PATTERNS = [
  "send message failed",
  "message couldn",
  "couldn't send",
  "not allowed to send",
  "blocked from sending",
  "temporarily blocked",
  "rate limited",
  "feature temporarily",
  "spam",
  "error 1545012",
  '"error":200',
  '"error":368',
  '"error":190',
  '"error":1357004',
  '"error":1357031',
  '"error":506',
  '"error":100',
  '"error":613',
  '"error":2000',
  '"error":10',
  "action blocked",
  "you can't send",
  "you cannot send",
  "your account has been restricted",
  "messaging restricted",
  "you've been blocked",
  "unable to send",
  "message limit",
  "too many messages",
  "send limit",
  "you're temporarily blocked from sending",
];

let _started        = false;
let _checkTimer     = null;
let _lastSwitch     = 0;
let _sendFailTimes  = [];
let _lastCookieScan = { result: "pending", ts: null };

function _log(msg) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ HEALTH ]: ", color: ["red", "cyan"] },
        { message: msg, color: "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[HEALTH]", msg);
}

function _isAuthError(errStr) {
  const s = errStr.toLowerCase();
  return AUTH_KEYWORDS.some(k => s.includes(k));
}

function _isSendBlockedError(errStr) {
  const s = errStr.toLowerCase();
  return SEND_BLOCKED_PATTERNS.some(p => s.includes(p));
}

function _recordSendFailure() {
  const now    = Date.now();
  const cutoff = now - SEND_FAIL_WINDOW_MS;
  _sendFailTimes = _sendFailTimes.filter(t => t > cutoff);
  _sendFailTimes.push(now);
  return _sendFailTimes.length;
}

function _resetSendFailures() {
  _sendFailTimes = [];
}

async function _triggerSwitch(api, reason) {
  const now = Date.now();
  if (now - _lastSwitch < SWITCH_COOLDOWN_MS) {
    _log(`Switch cooldown active — suppressing duplicate. Reason: ${reason}`);
    return;
  }
  _lastSwitch = now;
  _resetSendFailures();
  _log(`Triggering tier switch — ${reason}`);
  try {
    await forceTierSwitch(api, reason);
  } catch (e) {
    _log(`forceTierSwitch threw: ${e.message || e}`);
  }
}

function _patchSendMessage(api) {
  if (api.__healthMonitorPatched) return;
  api.__healthMonitorPatched = true;

  const original = api.sendMessage.bind(api);

  api.sendMessage = function monitoredSendMessage(form, threadID, callback, replyToMessage) {
    const run = async () => {
      return new Promise((resolve, reject) => {
        original(form, threadID, (err, info) => {
          if (err) {
            const errStr = String(err.message || err.error || err || "");
            if (!_isAuthError(errStr)) {
              const failCount = _recordSendFailure();
              const blocked   = _isSendBlockedError(errStr);
              _log(`Send error (${blocked ? "BLOCKED" : "generic"}) — ${errStr.slice(0, 120)} | window: ${failCount}/${SEND_FAIL_THRESHOLD}`);
              if (failCount >= SEND_FAIL_THRESHOLD) {
                _triggerSwitch(api, `${failCount} send failures in ${SEND_FAIL_WINDOW_MS / 60000}min — ${errStr.slice(0, 100)}`);
              }
            }
            return reject(err);
          }
          _resetSendFailures();
          resolve(info);
        }, replyToMessage);
      });
    };

    const p = run();
    if (typeof callback === "function") {
      p.then(info => callback(null, info)).catch(e => callback(e));
      return;
    }
    return p;
  };
}

async function _runCookieScan(api) {
  try {
    const appState = api.getAppState ? api.getAppState() : [];
    if (!Array.isArray(appState) || appState.length === 0) {
      _log("Cookie scan: no cookies available — skipping.");
      return;
    }

    const cookieStr = appState
      .filter(c => c && c.key && c.value)
      .map(c => `${c.key}=${c.value}`)
      .join("; ");

    if (!cookieStr) {
      _log("Cookie scan: empty cookie string — skipping.");
      return;
    }

    const alive = await checkLiveCookie(cookieStr);

    if (alive === false) {
      _lastCookieScan = { result: "dead", ts: Date.now() };
      _log("Cookie scan: session CONFIRMED DEAD — triggering re-login.");
      if (typeof global._triggerAutoRelogin === "function") {
        global._triggerAutoRelogin("health-monitor: cookie scan confirmed dead session");
      } else {
        _triggerSwitch(api, "health-monitor: cookie scan confirmed dead session");
      }
    } else if (alive === true) {
      _lastCookieScan = { result: "alive", ts: Date.now() };
      _log("Cookie scan: session alive ✓");
    } else {
      _lastCookieScan = { result: "uncertain", ts: Date.now() };
      _log("Cookie scan: uncertain (network issue) — no action.");
    }
  } catch (e) {
    _log(`Cookie scan threw: ${e.message || e}`);
  }
}

/**
 * Start the health monitor. Safe to call multiple times — subsequent
 * calls re-patch the api but don't restart the timers.
 *
 * @param {object} api  FCA API instance
 */
function start(api) {
  if (!api) return;

  // If already started (e.g. after tier switch), just re-patch the new api
  if (_started) {
    _patchSendMessage(api);
    return;
  }
  _started = true;

  _log("Account Health Monitor started.");
  _log(`  Cookie scan every ${CHECK_INTERVAL_MS / 60000} min`);
  _log(`  Send-fail threshold: ${SEND_FAIL_THRESHOLD} errors in ${SEND_FAIL_WINDOW_MS / 60000} min → tier switch`);

  _patchSendMessage(api);

  // Re-patch whenever the api reference changes after a tier switch
  global.__setHealthApi = function(newApi) {
    if (newApi && newApi !== api) _patchSendMessage(newApi);
  };

  // Periodic cookie health scan
  _checkTimer = setInterval(() => _runCookieScan(api), CHECK_INTERVAL_MS);

  // Initial scan after 30 seconds (give FCA time to settle)
  setTimeout(() => _runCookieScan(api), 30 * 1000);

  // Hourly health status broadcast to admins
  setInterval(() => {
    try {
      const now    = Date.now();
      const cutoff = now - SEND_FAIL_WINDOW_MS;
      const fails  = _sendFailTimes.filter(t => t > cutoff).length;
      const tier   = global.activeAccountTier || 1;
      const scanTs = _lastCookieScan.ts
        ? new Date(_lastCookieScan.ts).toISOString().replace("T", " ").slice(0, 19)
        : "never";
      const uptime = global._botStartTime
        ? Math.floor((now - global._botStartTime) / 60000) + " min"
        : "unknown";

      const admins = global.config?.admins || [];
      if (!api || !admins.length) return;

      const msg =
        `📊 Kami Health Report\n\n` +
        `🏦 Active Account: Tier ${tier}\n` +
        `⏱ Uptime: ${uptime}\n` +
        `🍪 Last Cookie Scan: ${scanTs} (${_lastCookieScan.result})\n` +
        `❌ Send Errors (${SEND_FAIL_WINDOW_MS / 60000}min window): ${fails}/${SEND_FAIL_THRESHOLD}\n` +
        `✅ Bot is running normally`;

      for (const adminID of admins) {
        const id = String(adminID).trim();
        if (id) api.sendMessage(msg, id).catch(() => {});
      }
    } catch (_) {}
  }, 60 * 60 * 1000);

  process.once("exit",    _stop);
  process.once("SIGTERM", _stop);
}

function _stop() {
  if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
  _started = false;
}

/**
 * Returns a snapshot of the health monitor's current state.
 */
function getStatus() {
  const now    = Date.now();
  const cutoff = now - SEND_FAIL_WINDOW_MS;
  return {
    sendFailCount:  _sendFailTimes.filter(t => t > cutoff).length,
    sendFailWindow: SEND_FAIL_WINDOW_MS,
    lastCookieScan: _lastCookieScan
  };
}

module.exports = { start, getStatus };
