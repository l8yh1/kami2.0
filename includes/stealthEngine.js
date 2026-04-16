"use strict";

const MODERN_USER_AGENTS = [
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    platform: '"macOS"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    secChUa: '',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    secChUa: '',
    platform: '"macOS"'
  }
];

function getCfg() {
  return global.config?.stealthMode || {};
}

function isNightMode() {
  const cfg = getCfg();
  if (!cfg.enabled || !cfg.nightModeSlowdown) return false;
  const hour  = new Date().getHours();
  const start = cfg.nightModeStart ?? 1;
  const end   = cfg.nightModeEnd   ?? 6;
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

class StealthEngine {
  constructor() {
    this._burstCounters  = new Map();
    this._burstCooldowns = new Map();
    this._threadJitter   = new Map();
    this._fingerprint    = null;
    this._lockFingerprint();
  }

  _lockFingerprint() {
    if (this._fingerprint) return this._fingerprint;
    const pick = MODERN_USER_AGENTS[Math.floor(Math.random() * MODERN_USER_AGENTS.length)];
    this._fingerprint = {
      ua:       pick.ua,
      secChUa:  pick.secChUa,
      platform: pick.platform,
      locale:   'en-US,en;q=0.9',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
      lockedAt: Date.now()
    };
    return this._fingerprint;
  }

  getFingerprint() {
    return this._fingerprint || this._lockFingerprint();
  }

  _getThreadJitter(threadID) {
    const key = String(threadID);
    if (!this._threadJitter.has(key)) {
      this._threadJitter.set(key, Math.floor(Math.random() * 600) + 200);
    }
    return this._threadJitter.get(key);
  }

  _incrementBurst(threadID) {
    const key = String(threadID);
    const now = Date.now();
    const entry = this._burstCounters.get(key) || { count: 0, windowStart: now };

    if (now - entry.windowStart > 15000) {
      entry.count = 1;
      entry.windowStart = now;
    } else {
      entry.count++;
    }

    this._burstCounters.set(key, entry);
    return entry.count;
  }

  isBurstCooldown(threadID) {
    const key      = String(threadID);
    const cooldown = this._burstCooldowns.get(key);
    if (!cooldown) return false;
    if (Date.now() >= cooldown) {
      this._burstCooldowns.delete(key);
      return false;
    }
    return true;
  }

  async handleIncoming(threadID) {
    const cfg = getCfg();
    if (!cfg.enabled) return;

    if (cfg.burstProtection) {
      const burst     = this._incrementBurst(threadID);
      const threshold = cfg.burstThreshold || 5;

      if (burst >= threshold) {
        const cooldownMs = cfg.burstCooldownMs || 8000;
        const until      = Date.now() + cooldownMs + Math.floor(Math.random() * 2000);
        this._burstCooldowns.set(String(threadID), until);
        await new Promise(r => setTimeout(r, cooldownMs * 0.4));
      }
    }

    if (isNightMode()) {
      const nightDelay = 1500 + Math.floor(Math.random() * 2500);
      await new Promise(r => setTimeout(r, nightDelay));
    }

    const jitter = this._getThreadJitter(threadID);
    await new Promise(r => setTimeout(r, jitter));
  }

  async randomizeReadReceipt(api, threadID) {
    const cfg = getCfg();
    if (!cfg.enabled || !cfg.randomizeReadReceipts) return;
    if (typeof api?.markAsRead !== 'function') return;

    const baseDelay = cfg.readReceiptDelay || 1500;
    const delay     = baseDelay + Math.floor(Math.random() * baseDelay);

    setTimeout(() => {
      try { api.markAsRead(threadID, () => {}); } catch (_) {}
    }, delay);
  }

  getNightModeStatus() {
    return {
      active:     isNightMode(),
      hour:       new Date().getHours(),
      nightStart: getCfg().nightModeStart ?? 1,
      nightEnd:   getCfg().nightModeEnd   ?? 6
    };
  }

  getStatus() {
    return {
      enabled:       getCfg().enabled,
      nightMode:     this.getNightModeStatus(),
      burstCounters: Object.fromEntries(this._burstCounters),
      fingerprint:   { ua: this._fingerprint?.ua, platform: this._fingerprint?.platform }
    };
  }
}

const globalStealthEngine = new StealthEngine();

module.exports = { StealthEngine, globalStealthEngine, isNightMode };
