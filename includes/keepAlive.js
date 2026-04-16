"use strict";

/**
 * keepAlive.js — Session maintenance for Kami
 * - Pings Facebook every 5-18 minutes via rotating endpoints
 * - Saves cookies periodically
 * - Refreshes fb_dtsg every 24 hours
 * - Uses realistic browser headers and diverse endpoints for stealth
 */

const axios  = require('axios');
const fs     = require('fs-extra');
const path   = require('path');

let pingTimer = null;
let dtsgTimer = null;
let saveTimer = null;
let isSaving  = false;

function log(level, msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([{ message: '[ KEEP-ALIVE ]: ', color: ['red', 'cyan'] }, { message: msg, color: 'white' }]);
      return;
    }
  } catch (_) {}
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console[level === 'error' ? 'error' : 'log'](`${ts} [KEEP-ALIVE]`, msg);
}

function getRandomMs(minMin, maxMin) {
  return Math.floor(Math.random() * ((maxMin - minMin) * 60000 + 1)) + minMin * 60000;
}

function getCookieStr(api) {
  const appState = api.getAppState();
  if (!appState || !appState.length) return null;
  return appState.map(c => `${c.key}=${c.value}`).join('; ');
}

const MODERN_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];

function getUserAgent() {
  if (global.config?.login?.userAgent && !global.config?.stealthMode?.rotateUserAgentOnReconnect) {
    return global.config.login.userAgent;
  }
  return MODERN_USER_AGENTS[Math.floor(Math.random() * MODERN_USER_AGENTS.length)];
}

const PING_ENDPOINTS = [
  { url: 'https://mbasic.facebook.com/',        label: 'mbasic',       referer: null },
  { url: 'https://mbasic.facebook.com/home.php', label: 'mbasic-home', referer: 'https://mbasic.facebook.com/' },
  { url: 'https://www.facebook.com/home.php',    label: 'www-home',    referer: 'https://www.facebook.com/' },
  { url: 'https://www.facebook.com/messages/',   label: 'www-messages', referer: 'https://www.facebook.com/home.php' },
  { url: 'https://www.facebook.com/notifications', label: 'www-notifs', referer: 'https://www.facebook.com/' }
];

let _lastEndpointIndex = -1;

function pickEndpoint() {
  const stealth = global.config?.stealthMode;
  if (!stealth?.enabled || !stealth?.diversePingEndpoints) return PING_ENDPOINTS[0];
  let idx;
  do { idx = Math.floor(Math.random() * PING_ENDPOINTS.length); }
  while (idx === _lastEndpointIndex && PING_ENDPOINTS.length > 1);
  _lastEndpointIndex = idx;
  return PING_ENDPOINTS[idx];
}

function buildHeaders(cookieStr, userAgent, referer) {
  const headers = {
    'cookie':                    cookieStr,
    'user-agent':                userAgent,
    'accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language':           'en-US,en;q=0.9,ar;q=0.7',
    'accept-encoding':           'gzip, deflate, br',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest':            'document',
    'sec-fetch-mode':            'navigate',
    'sec-fetch-site':            referer ? 'same-origin' : 'none',
    'sec-fetch-user':            '?1',
    'cache-control':             'max-age=0',
    'dnt':                       '1'
  };
  if (referer) headers['referer'] = referer;
  return headers;
}

async function httpGet(url, cookieStr, userAgent, referer) {
  return axios.get(url, {
    headers: buildHeaders(cookieStr, userAgent, referer),
    timeout: 18000,
    maxRedirects: 5,
    validateStatus: () => true
  });
}

function isLoginPage(html, responseUrl) {
  const url  = String(responseUrl || '');
  const body = String(html || '');
  return (
    /\/login[/?]/.test(url) ||
    body.includes('id="login_form"') ||
    body.includes('You must log in to continue') ||
    body.includes('Log in to Facebook')
  );
}

async function doPing() {
  try {
    const api = global._botApi;
    if (!api) return;

    const cookieStr = getCookieStr(api);
    if (!cookieStr) return;

    const UA       = getUserAgent();
    const endpoint = pickEndpoint();
    let success    = false;

    try {
      const r      = await httpGet(endpoint.url, cookieStr, UA, endpoint.referer);
      const html   = String(r.data || '');
      const resUrl = String(r.request?.res?.responseUrl || r.config?.url || '');

      if (isLoginPage(html, resUrl)) {
        log('warn', `Ping ${endpoint.label} → login page — session may have expired!`);
      } else {
        success = true;
        log('info', `Ping ${endpoint.label} ✓ — session alive`);
      }
    } catch (e) {
      log('warn', `Ping ${endpoint.label} failed: ${e.message || e}`);
    }

    if (!success) {
      const fallback = PING_ENDPOINTS[0];
      try {
        const r2     = await httpGet(fallback.url, cookieStr, getUserAgent(), null);
        const html2  = String(r2.data || '');
        const resUrl2 = String(r2.request?.res?.responseUrl || '');
        if (isLoginPage(html2, resUrl2)) {
          log('warn', 'Fallback ping → login page — session expired!');
        } else {
          success = true;
          log('info', `Fallback ping ${fallback.label} ✓`);
        }
      } catch (e) {
        log('warn', `Fallback ping failed: ${e.message || e}`);
      }
    }

    if (success) {
      global.lastMqttActivity = Date.now();
      await doSaveCookies('post-ping');
    }
  } catch (e) {
    log('warn', `doPing unexpected error: ${e.message || e}`);
  }
}

async function doSaveCookies(source) {
  if (isSaving) return;
  if (global.isRelogining) return;
  isSaving = true;
  try {
    const api = global._botApi;
    if (!api) return;

    const appState = api.getAppState();
    if (!appState || !appState.length) return;

    const configPath  = global.config?.appStatePath || 'appstate.json';
    const statePath   = path.isAbsolute(configPath)
      ? configPath
      : path.join(process.cwd(), configPath);
    const backupPath  = statePath.replace(/\.json$/, '-backup.json');
    const newData     = JSON.stringify(appState, null, 2);

    const current = await fs.readFile(statePath, 'utf-8').catch(() => '');
    if (current.trim() === newData.trim()) return;

    const tmpPath = statePath + '.tmp';
    await fs.writeFile(tmpPath, newData, 'utf-8');
    await fs.move(tmpPath, statePath, { overwrite: true });
    await fs.writeFile(backupPath, newData, 'utf-8').catch(() => {});

    log('info', `Cookies saved${source ? ` (${source})` : ''} ✓`);
  } catch (e) {
    log('warn', `Failed to save cookies: ${e.message || e}`);
  } finally {
    isSaving = false;
  }
}

async function doRefreshDtsg() {
  try {
    const api = global._botApi;
    if (!api || typeof api.refreshFb_dtsg !== 'function') return;
    await api.refreshFb_dtsg();
    log('info', 'fb_dtsg token refreshed ✓');
    await doSaveCookies('post-dtsg-refresh');
  } catch (e) {
    log('warn', `fb_dtsg refresh failed: ${e.message || e}`);
  }
}

function getNightModeMultiplier() {
  try {
    const { isNightMode } = require('./humanTyping');
    return isNightMode() ? 1.6 : 1.0;
  } catch (_) {
    return 1.0;
  }
}

function schedulePing() {
  if (pingTimer) clearTimeout(pingTimer);
  const cfg        = global.config?.keepAlive || {};
  const baseFactor = getNightModeMultiplier();
  const minMin     = (cfg.pingMinIntervalMin || 5) * baseFactor;
  const maxMin     = (cfg.pingMaxIntervalMin || 10) * baseFactor;
  const delay      = getRandomMs(minMin, maxMin);
  const minutes    = Math.round(delay / 60000);
  pingTimer = setTimeout(async () => {
    await doPing();
    schedulePing();
  }, delay);
  log('info', `Next ping in ${minutes} min`);
}

function startKeepAlive() {
  if (pingTimer) clearTimeout(pingTimer);
  if (dtsgTimer) clearInterval(dtsgTimer);
  if (saveTimer)  clearInterval(saveTimer);

  const cfg = global.config?.keepAlive || {};
  const saveIntervalHours = cfg.saveCookiesIntervalHours || 2;
  const dtsgIntervalHours = cfg.refreshDtsgIntervalHours || 48;

  log('info', `Session keep-alive started — Ping every ${cfg.pingMinIntervalMin || 5}-${cfg.pingMaxIntervalMin || 10} min | cookies every ${saveIntervalHours}h | dtsg every ${dtsgIntervalHours}h`);

  schedulePing();

  saveTimer = setInterval(() => doSaveCookies('scheduled'), saveIntervalHours * 60 * 60 * 1000);
  dtsgTimer = setInterval(() => doRefreshDtsg(), dtsgIntervalHours * 60 * 60 * 1000);
}

function stopKeepAlive() {
  if (pingTimer) clearTimeout(pingTimer);
  if (dtsgTimer) clearInterval(dtsgTimer);
  if (saveTimer)  clearInterval(saveTimer);
  pingTimer = dtsgTimer = saveTimer = null;
}

module.exports = { startKeepAlive, stopKeepAlive, doSaveCookies, doPing };
