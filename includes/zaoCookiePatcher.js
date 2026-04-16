"use strict";

/**
 * zaoCookiePatcher — patches the FCA API instance after login.
 *
 * What it does:
 *  1. Filters false-positive suspension signals from the library's built-in
 *     anti-suspension, preventing unnecessary circuit-breaker trips.
 *  2. Hooks getAppState() to auto-persist cookies to disk on every refresh.
 *  3. Adds a getBotInfo() shim for cookie sessions that lack it.
 *  4. Exposes active tier info on the api object for monitoring.
 *  5. Guards setOptions() to preserve the minimum required options.
 */

const fs   = require("fs-extra");
const path = require("path");

const FALSE_POSITIVE_SIGNALS = new Set([
  "something went wrong",
  "please try again later",
  "feature temporarily unavailable",
  "feature temporarily blocked",
  "this content isn't available",
]);

function _makeLog() {
  return function log(msg) {
    try {
      if (global.loggeryuki) {
        global.loggeryuki.log([
          { message: "[ COOKIE-PATCH ]: ", color: ["red", "cyan"] },
          { message: msg, color: "white" }
        ]);
        return;
      }
    } catch (_) {}
    console.log("[COOKIE-PATCH]", msg);
  };
}

/**
 * @param {object} api           - The raw FCA API object from nkxfca
 * @param {object} accountInfo   - { tier, stateFile, altFile, loginMethod }
 * @returns {object}             - The patched api (same reference)
 */
function patchCookieApi(api, accountInfo = {}) {
  if (!api || api.__zaoCookiePatched) return api;
  const log = _makeLog();

  const stateFile = accountInfo.stateFile
    || (global.config?.appStatePath ? path.resolve(process.cwd(), global.config.appStatePath) : null);
  const altFile   = accountInfo.altFile
    || (stateFile ? stateFile.replace(/\.json$/, "-backup.json") : null);

  // ── 1. Filter false-positive suspension signals from the library ──────────
  try {
    const fcaAntiSusp = require("@neoaz07/nkxfca/src/utils/antiSuspension");
    const instance    = fcaAntiSusp && fcaAntiSusp.globalAntiSuspension;

    if (instance && !instance.__kamiPatchedSignals) {
      const originalDetect = instance.detectSuspensionSignal.bind(instance);
      instance.detectSuspensionSignal = function patchedDetect(text) {
        if (!text || typeof text !== "string") return false;
        const lower = text.toLowerCase();
        for (const fp of FALSE_POSITIVE_SIGNALS) {
          if (lower.includes(fp)) {
            const hasRealSignal = [
              "checkpoint", "action_required", "account_locked", "account_suspended",
              "account banned", "account has been disabled", "unusual_activity",
              "verify_your_account", "login_approvals", "bot detected",
              "automated_behavior", "spam_detected", "policy violation"
            ].some(s => lower.includes(s));
            if (!hasRealSignal) return false;
          }
        }
        return originalDetect(text);
      };
      instance.__kamiPatchedSignals = true;
      log("False-positive suspension filter applied ✓");
    }
  } catch (e) {
    log("Could not patch FCA anti-suspension: " + e.message);
  }

  // ── 2. Auto-persist cookies on every getAppState() call ──────────────────
  if (stateFile && typeof api.getAppState === "function") {
    const originalGetAppState = api.getAppState.bind(api);
    let _persistPending = false;
    api.getAppState = function patchedGetAppState() {
      const state = originalGetAppState();
      if (Array.isArray(state) && state.length > 0 && !_persistPending) {
        _persistPending = true;
        setImmediate(() => {
          _persistPending = false;
          try {
            const data = JSON.stringify(state, null, 2);
            fs.writeFileSync(stateFile, data, "utf-8");
            if (altFile) {
              try { fs.writeFileSync(altFile, data, "utf-8"); } catch (_) {}
            }
          } catch (_) {}
        });
      }
      return state;
    };
    log("Cookie auto-persist hooked ✓");
  }

  // ── 3. getBotInfo shim for cookie sessions ────────────────────────────────
  if (typeof api.getBotInfo !== "function") {
    api.getBotInfo = async function cookieBotInfo() {
      const uid = api.getCurrentUserID ? api.getCurrentUserID() : null;
      if (!uid) return { uid: null };
      try {
        const info = await new Promise((res, rej) => {
          if (typeof api.getUserInfo === "function") {
            api.getUserInfo(uid, (err, data) => {
              if (err) return rej(err);
              res(data && data[uid] ? data[uid] : data);
            });
          } else {
            res({ uid });
          }
        });
        return info || { uid };
      } catch (_) {
        return { uid };
      }
    };
    log("getBotInfo shim installed ✓");
  }

  // ── 4. Expose active tier info on the api object ──────────────────────────
  api.__kamiAccountTier  = accountInfo.tier    || global.activeAccountTier || 1;
  api.__kamiStateFile    = stateFile;
  api.__kamiAltFile      = altFile;
  api.__kamiLoginMethod  = accountInfo.loginMethod || "appstate";

  // ── 5. Guard setOptions() from overriding required features ──────────────
  if (typeof api.setOptions === "function") {
    const originalSetOptions = api.setOptions.bind(api);
    api.setOptions = function patchedSetOptions(opts) {
      const safe = Object.assign({ listenEvents: true, autoReconnect: true }, opts);
      return originalSetOptions(safe);
    };
  }

  api.__zaoCookiePatched = true;
  log(`Cookie patcher active — tier=${api.__kamiAccountTier} method=${api.__kamiLoginMethod} ✓`);
  return api;
}

module.exports = { patchCookieApi, FALSE_POSITIVE_SIGNALS };
