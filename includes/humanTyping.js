"use strict";

function isNightMode() {
  const cfg = global.config?.stealthMode;
  if (!cfg || !cfg.enabled || !cfg.nightModeSlowdown) return false;
  const hour  = new Date().getHours();
  const start = cfg.nightModeStart ?? 1;
  const end   = cfg.nightModeEnd   ?? 6;
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function calcDelay(form) {
  const cfg = global.config?.humanTyping;
  if (!cfg || !cfg.enable) return 0;

  let text = '';
  if (typeof form === 'string') text = form;
  else if (form && typeof form.body === 'string') text = form.body;

  const minDelay  = cfg.minDelay       || 800;
  const maxDelay  = cfg.maxDelay       || 4200;
  const cps       = cfg.charsPerSecond || 12;
  const jitterPct = cfg.jitterPercent  || 30;

  let delay = (text.length / cps) * 1000;
  delay = Math.max(minDelay, Math.min(delay, maxDelay));

  const jitter = delay * (jitterPct / 100);
  delay += (Math.random() * jitter * 2) - jitter;

  if (!text && form && form.attachment) delay = minDelay + Math.random() * 800;

  if (isNightMode()) {
    const multiplier = cfg.nightModeMultiplier || 2.2;
    delay *= multiplier;
    delay += Math.random() * 1200;
  }

  const thinkChance = cfg.thinkingPauseChance || 0.18;
  if (Math.random() < thinkChance && text.length > 20) {
    delay += cfg.thinkingPauseMs || 1800;
  }

  return Math.max(300, Math.round(delay));
}

async function simulateTyping(api, threadID, delayMs) {
  if (!delayMs) return;

  const halfPoint = Math.floor(delayMs * (0.4 + Math.random() * 0.3));
  const remainder = delayMs - halfPoint;

  try {
    if (typeof api.sendTypingIndicator === 'function') {
      const r = api.sendTypingIndicator(threadID, () => {});
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  } catch (_) {}

  await new Promise(resolve => setTimeout(resolve, halfPoint));

  const cfg = global.config?.humanTyping;
  const thinkChance = cfg?.thinkingPauseChance || 0.18;
  if (Math.random() < thinkChance) {
    try {
      if (typeof api.sendTypingIndicator === 'function') {
        const r2 = api.sendTypingIndicator(threadID, () => {});
        if (r2 && typeof r2.catch === 'function') r2.catch(() => {});
      }
    } catch (_) {}
  }

  await new Promise(resolve => setTimeout(resolve, remainder));
}

function wrapApiWithTyping(api, threadID) {
  const _orig = api.sendMessage.bind(api);
  return Object.assign(Object.create(api), {
    sendMessage: async function (form, tid, ...rest) {
      const target = tid || threadID;
      const delay  = calcDelay(form);
      if (delay > 0) await simulateTyping(api, target, delay);
      return _orig(form, target, ...rest);
    }
  });
}

module.exports = { calcDelay, simulateTyping, wrapApiWithTyping, isNightMode };
