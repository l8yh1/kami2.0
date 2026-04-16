"use strict";

/**
 * nkxfcaPatcher — applies runtime fixes to the nkxfca library.
 *
 * Problem: node_modules can be reset (npm install), reverting any edits
 * made directly to library files.
 *
 * This module patches the library in-memory at startup so fixes always
 * apply regardless of which version is installed.
 *
 * Fixes:
 *  1. Exit-handler safety — prevents loginHelper from registering an
 *     uncaughtException handler that calls process.exit(1), which would
 *     kill the bot before it can save state or switch tiers.
 *
 *  2. AntiSuspension limits — raises daily/hourly caps and shortens the
 *     warmup window so heavy-group traffic is not throttled by the
 *     library's conservative defaults.
 */

function preventLoginHelperHandlers() {
  if (!process._nkxfcaCleanupRegistered) {
    process._nkxfcaCleanupRegistered = true;
  }
}

/**
 * Call AFTER login() to patch the nkxfca library's globalAntiSuspension
 * instance with higher, production-appropriate limits.
 *
 *  Old (library defaults) → New (patched)
 *  maxDailyMessages  1 500  → 10 000
 *  maxPerHour          220  → 600
 *  warmup.durationMs 20min  → 2 min
 *  warmup max/hr        25  → 200
 */
function patchAntiSuspensionLimits() {
  try {
    const nkxAntiSusp = require("@neoaz07/nkxfca/src/utils/antiSuspension");
    const gas = nkxAntiSusp && nkxAntiSusp.globalAntiSuspension;
    if (!gas) return;

    gas.dailyStats.maxDailyMessages   = 10000;
    gas.hourlyBucket.maxPerHour       = 600;
    gas.warmup.durationMs             = 2 * 60 * 1000;
    gas.warmup.maxMessagesPerHour     = 200;

    const log = _makeLog();
    log("Library anti-suspension limits patched (daily=10k hourly=600) ✓");
  } catch (_) {}
}

function _makeLog() {
  return function log(msg) {
    try {
      if (global.loggeryuki) {
        global.loggeryuki.log([
          { message: "[ PATCHER ]: ", color: ["red", "cyan"] },
          { message: msg, color: "white" }
        ]);
        return;
      }
    } catch (_) {}
    console.log("[PATCHER]", msg);
  };
}

module.exports = { preventLoginHelperHandlers, patchAntiSuspensionLimits };
