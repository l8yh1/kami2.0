"use strict";

/**
 * tierSwitch.js — Multi-account tier switching for Kami
 *
 * When the session expires this module tries to re-establish it.
 * It is multi-account-aware: tries the same tier first (refreshing
 * cookies), then advances to the next tier if the current one is dead.
 *
 * Tier order: 1 → 2 → 3
 *   Tier 1: appstate.json / appstate-backup.json
 *   Tier 2: appstate2.json / appstate2-backup.json
 *   Tier 3: appstate3.json / appstate3-backup.json
 */

const fs   = require('fs-extra');
const path = require('path');

const COOLDOWN_MS   = 3 * 60 * 1000;
const MAX_RETRIES   = 4;
const RESTART_DELAY = 3000;

const TIERS = [
  { tier: 1, stateFile: 'appstate.json',  altFile: 'appstate-backup.json'  },
  { tier: 2, stateFile: 'appstate2.json', altFile: 'appstate2-backup.json' },
  { tier: 3, stateFile: 'appstate3.json', altFile: 'appstate3-backup.json' },
];

const TIER_PERSIST_FILE = path.join(process.cwd(), 'logs', 'active-tier.json');

function writePersistedTier(tier) {
  try {
    fs.ensureDirSync(path.dirname(TIER_PERSIST_FILE));
    fs.writeFileSync(TIER_PERSIST_FILE, JSON.stringify({ tier, ts: new Date().toISOString() }, null, 2), 'utf-8');
  } catch (_) {}
}

function readPersistedTier() {
  try {
    if (!fs.existsSync(TIER_PERSIST_FILE)) return 1;
    const data = JSON.parse(fs.readFileSync(TIER_PERSIST_FILE, 'utf-8'));
    return data.tier || 1;
  } catch (_) {
    return 1;
  }
}

let lastAttempt    = 0;
let retryCount     = 0;
let isAttempting   = false;
let currentTierIdx = 0;

function log(level, msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([{ message: '[ TIER-SWITCH ]: ', color: ['red', 'cyan'] }, { message: msg, color: 'white' }]);
      return;
    }
  } catch (_) {}
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console[level === 'error' ? 'error' : 'log'](`${ts} [TIER-SWITCH]`, msg);
}

function notifyAdmins(message) {
  try {
    const api    = global._botApi;
    const admins = global.config?.admins || [];
    if (!api) return;
    for (const adminID of admins) {
      const id = String(adminID).trim();
      if (!id) continue;
      try { api.sendMessage(message, id).catch(() => {}); } catch (_) {}
    }
  } catch (_) {}
}

function buildLoginOptions() {
  return Object.assign({
    autoReconnect:         true,
    listenEvents:          true,
    autoMarkRead:          true,
    simulateTyping:        true,
    randomUserAgent:       false,
    persona:               'desktop',
    maxConcurrentRequests: 5,
    maxRequestsPerMinute:  50,
    requestCooldownMs:     60000,
    errorCacheTtlMs:       300000,
  }, global.config?.login || {});
}

function loginAsync(loginArg, opts) {
  return new Promise((resolve, reject) => {
    try {
      const { login } = require('@neoaz07/nkxfca');
      login(loginArg, opts, (err, api) => {
        if (err) return reject(err);
        resolve(api);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function readAppState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return null;
  } catch (_) {
    return null;
  }
}

function saveState(stateFile, altFile, appState) {
  try {
    const data = JSON.stringify(appState, null, 2);
    fs.writeFileSync(stateFile, data, 'utf-8');
    if (altFile) {
      try { fs.writeFileSync(altFile, data, 'utf-8'); } catch (_) {}
    }
  } catch (_) {}
}

async function tryTierLogin(tierInfo) {
  const cwd   = process.cwd();
  const opts  = buildLoginOptions();

  const stateFullPath = path.join(cwd, tierInfo.stateFile);
  const altFullPath   = path.join(cwd, tierInfo.altFile);

  const appState = readAppState(stateFullPath) || readAppState(altFullPath);
  if (appState) {
    try {
      const newApi = await loginAsync({ appState }, opts);
      const uid    = newApi && typeof newApi.getCurrentUserID === 'function' ? newApi.getCurrentUserID() : null;
      if (uid && uid !== '0') return { newApi, stateFullPath, altFullPath };
    } catch (e) {
      log('warn', `Tier ${tierInfo.tier} appstate login failed: ${e.message}`);
    }
  }

  if (tierInfo.tier === 1) {
    const email    = process.env.FB_EMAIL    || global.config?.login?.email;
    const password = process.env.FB_PASSWORD || global.config?.login?.password;
    if (email && password) {
      try {
        const newApi = await loginAsync({ email, password }, opts);
        const uid    = newApi && typeof newApi.getCurrentUserID === 'function' ? newApi.getCurrentUserID() : null;
        if (uid && uid !== '0') return { newApi, stateFullPath, altFullPath };
      } catch (e) {
        log('warn', `Tier 1 credential login failed: ${e.message}`);
      }
    }
  }

  return null;
}

async function forceTierSwitch(reason) {
  if (isAttempting) {
    log('warn', 'forceTierSwitch: re-login already in progress — skipping.');
    return false;
  }

  const activeTier = global.activeAccountTier || 1;
  let idx = TIERS.findIndex(t => t.tier === activeTier);
  if (idx === -1) idx = 0;

  const nextIdx = idx + 1;
  if (nextIdx >= TIERS.length) {
    log('error', 'forceTierSwitch: all tiers exhausted — cannot switch further.');
    notifyAdmins(
      `⛔ HEALTH MONITOR: all ${TIERS.length} account tiers have been tried.\n` +
      `Please upload fresh cookie files.\nReason: ${reason || 'send failures'}`
    );
    return false;
  }

  currentTierIdx = nextIdx;
  retryCount     = 0;
  lastAttempt    = 0;
  isAttempting   = true;

  const tierInfo = TIERS[currentTierIdx];
  log('warn', `forceTierSwitch → Tier ${tierInfo.tier} (${tierInfo.stateFile}) | reason: ${reason || 'send failures'}`);
  notifyAdmins(
    `🔄 TIER SWITCH\n\nSwitching to Tier ${tierInfo.tier} due to send failures.\nReason: ${reason || 'consecutive message send failures'}`
  );

  let loginResult = null;
  try { loginResult = await tryTierLogin(tierInfo); }
  catch (e) { log('error', `forceTierSwitch: login threw: ${e.message}`); }

  isAttempting = false;

  if (!loginResult) {
    log('error', `forceTierSwitch: Tier ${tierInfo.tier} login failed.`);
    notifyAdmins(`❌ TIER SWITCH: Tier ${tierInfo.tier} also failed.`);
    retryCount = MAX_RETRIES;
    return false;
  }

  const { newApi, stateFullPath, altFullPath } = loginResult;
  try {
    const freshState = newApi.getAppState ? newApi.getAppState() : [];
    saveState(stateFullPath, altFullPath, freshState);
    retryCount               = 0;
    global.activeAccountTier = tierInfo.tier;
    global._botApi           = newApi;
    writePersistedTier(tierInfo.tier);
    log('info', `forceTierSwitch: success — Tier ${tierInfo.tier}. Restarting in ${RESTART_DELAY / 1000}s...`);
    notifyAdmins(`✅ TIER SWITCH: switched to Tier ${tierInfo.tier} successfully. Bot restarting...`);
    isAttempting = true;
    setTimeout(() => process.exit(0), RESTART_DELAY);
    return true;
  } catch (saveErr) {
    log('error', `forceTierSwitch: login ok but could not save cookies: ${saveErr.message}`);
    return false;
  }
}

async function autoRelogin(reason) {
  const now = Date.now();

  if (isAttempting) {
    log('warn', 'Already attempting re-login — skipping duplicate call.');
    return false;
  }

  if (now - lastAttempt < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (now - lastAttempt)) / 1000);
    log('warn', `Cooldown active. Next attempt in ${waitSec}s.`);
    return false;
  }

  const activeTier = global.activeAccountTier || readPersistedTier() || 1;
  currentTierIdx   = TIERS.findIndex(t => t.tier === activeTier);
  if (currentTierIdx === -1) currentTierIdx = 0;

  if (retryCount >= MAX_RETRIES) {
    if (currentTierIdx + 1 < TIERS.length) {
      currentTierIdx++;
      retryCount = 0;
      log('warn', `Tier ${activeTier} exhausted. Advancing to Tier ${TIERS[currentTierIdx].tier}...`);
    } else {
      log('error', `All ${TIERS.length} account tiers exhausted. Manual intervention required.`);
      notifyAdmins(
        `⛔ ALL TIERS FAILED\n\nTried all ${TIERS.length} tiers — none could login.\n` +
        `Please update cookie files.`
      );
      return false;
    }
  }

  isAttempting = true;
  lastAttempt  = now;
  retryCount++;

  const tierInfo  = TIERS[currentTierIdx];
  const reasonMsg = reason ? ` | reason: ${String(reason).slice(0, 180)}` : '';

  log('info', `Re-login attempt ${retryCount}/${MAX_RETRIES} — Tier ${tierInfo.tier} (${tierInfo.stateFile})${reasonMsg}`);
  notifyAdmins(
    `🔄 SESSION EXPIRED — Attempting auto re-login...\n` +
    `Tier ${tierInfo.tier} | Attempt ${retryCount}/${MAX_RETRIES}` +
    (reasonMsg ? `\n${reasonMsg}` : '')
  );

  let loginResult = null;
  try { loginResult = await tryTierLogin(tierInfo); }
  catch (e) { log('error', `Re-login threw error: ${e.message}`); }

  isAttempting = false;

  if (!loginResult) {
    log('error', `Re-login failed for Tier ${tierInfo.tier}.`);
    notifyAdmins(`❌ AUTO RELOGIN FAILED (Tier ${tierInfo.tier} attempt ${retryCount}/${MAX_RETRIES})`);
    return false;
  }

  const { newApi, stateFullPath, altFullPath } = loginResult;
  try {
    const freshState = newApi.getAppState ? newApi.getAppState() : [];
    saveState(stateFullPath, altFullPath, freshState);
    retryCount               = 0;
    global.activeAccountTier = tierInfo.tier;
    global._botApi           = newApi;
    writePersistedTier(tierInfo.tier);
    log('info', `Re-login success — Tier ${tierInfo.tier}. Restarting in ${RESTART_DELAY / 1000}s...`);
    notifyAdmins(`✅ AUTO RELOGIN SUCCESS\n\nTier ${tierInfo.tier} session restored. Bot is restarting...`);
    isAttempting = true;
    setTimeout(() => process.exit(0), RESTART_DELAY);
    return true;
  } catch (saveErr) {
    log('error', `Re-login succeeded but could not save cookies: ${saveErr.message}`);
    notifyAdmins(`❌ Re-login succeeded but failed to save: ${saveErr.message}`);
    return false;
  }
}

module.exports                 = autoRelogin;
module.exports.forceTierSwitch = forceTierSwitch;
module.exports.readPersistedTier = readPersistedTier;
