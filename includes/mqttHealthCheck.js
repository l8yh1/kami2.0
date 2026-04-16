"use strict";

let healthTimer  = null;
let restartCount = 0;
let backoffMs    = 0;

function getConfig() {
  const cfg = global.config?.mqttHealthCheck || {};
  return {
    enable:              cfg.enable !== false,
    silentTimeoutMs:     (cfg.silentTimeoutMinutes   || 5)  * 60 * 1000,
    checkIntervalMinMs:  (cfg.checkIntervalMinMinutes || 2)  * 60 * 1000,
    checkIntervalMaxMs:  (cfg.checkIntervalMaxMinutes || 5)  * 60 * 1000,
    maxRestarts:          cfg.maxRestarts          || 5,
    notifyAdmins:         cfg.notifyAdmins         !== false,
    backoffMultiplier:    cfg.backoffMultiplier     || 1.5,
    maxBackoffMs:        (cfg.maxBackoffMinutes     || 15) * 60 * 1000
  };
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function log(level, msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([{ message: '[ MQTT-HEALTH ]: ', color: ['red', 'cyan'] }, { message: msg, color: 'white' }]);
      return;
    }
  } catch (_) {}
  console[level === 'error' ? 'error' : 'log']('[MQTT-HEALTH]', msg);
}

function sendAdminMessage(message) {
  try {
    const api    = global._botApi;
    const admins = global.config?.admins || [];
    if (!api) return;
    for (const adminID of admins) {
      const id = String(adminID).trim();
      if (!id) continue;
      try { api.sendMessage(message, id).catch(() => {}); } catch (_) {}
    }
  } catch (e) {}
}

async function doHealthCheck() {
  const cfg = getConfig();
  if (!cfg.enable) return scheduleNextCheck();

  const api = global._botApi;
  if (!api)  return scheduleNextCheck();

  const lastActivity = global.lastMqttActivity || global._botStartTime || Date.now();
  const silentFor    = Date.now() - lastActivity;

  if (silentFor < cfg.silentTimeoutMs) {
    backoffMs = 0;
    return scheduleNextCheck();
  }

  if (global.isRelogining) {
    log('warn', 'Re-login in progress — skipping MQTT health check.');
    return scheduleNextCheck();
  }

  if (restartCount >= cfg.maxRestarts) {
    log('error', `Max restarts reached (${cfg.maxRestarts}). Stopping MQTT health check.`);
    stopHealthCheck();
    if (cfg.notifyAdmins) {
      sendAdminMessage(`⛔ MQTT Health Check\n\nBot restarted MQTT ${cfg.maxRestarts} times without recovery.\nManual intervention required.`);
    }
    return;
  }

  if (backoffMs > 0) {
    log('warn', `Waiting ${Math.round(backoffMs / 1000)}s before next attempt...`);
    await new Promise(r => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * cfg.backoffMultiplier, cfg.maxBackoffMs);
  } else {
    backoffMs = randomBetween(15000, 45000);
  }

  restartCount++;
  const silentMinutes = Math.round(silentFor / 60000);
  log('warn', `No MQTT activity for ${silentMinutes} min. Restarting listener (${restartCount}/${cfg.maxRestarts})...`);

  if (cfg.notifyAdmins) {
    sendAdminMessage(`⚠️ MQTT Health Check\n\nNo activity for ${silentMinutes} min.\nRestarting listener (attempt ${restartCount}/${cfg.maxRestarts})...`);
  }

  try {
    if (global.handleListen && typeof global.handleListen.stopListening === 'function') {
      try { global.handleListen.stopListening(); } catch (_) {}
    }

    const pauseMs = randomBetween(800, 2500);
    await new Promise(r => setTimeout(r, pauseMs));

    if (typeof global._restartListener === 'function') {
      global.lastMqttActivity = Date.now();
      log('info', 'Restarting listener to recover MQTT...');
      global._restartListener();
      restartCount = 0;
      backoffMs    = 0;
    } else {
      log('warn', 'Restart function not available yet — updating timestamp and retrying later.');
      global.lastMqttActivity = Date.now();
    }
  } catch (e) {
    log('error', 'Error during restart: ' + (e?.message || e));
  }

  scheduleNextCheck();
}

function scheduleNextCheck() {
  if (healthTimer) clearTimeout(healthTimer);
  const cfg     = getConfig();
  if (!cfg.enable) return;
  const delay   = randomBetween(cfg.checkIntervalMinMs, cfg.checkIntervalMaxMs);
  const minutes = (delay / 60000).toFixed(1);
  log('info', `Next check in ${minutes} min`);
  healthTimer = setTimeout(doHealthCheck, delay);
}

function startHealthCheck() {
  if (healthTimer) clearTimeout(healthTimer);
  restartCount = 0;
  backoffMs    = 0;
  global.lastMqttActivity = Date.now();

  const cfg = getConfig();
  if (!cfg.enable) {
    log('info', 'MQTT health check disabled in config.');
    return;
  }

  log('info',
    `Started — checking every ${cfg.checkIntervalMinMs / 60000}–${cfg.checkIntervalMaxMs / 60000} min, ` +
    `restart if silent ${cfg.silentTimeoutMs / 60000} min`
  );
  scheduleNextCheck();
}

function stopHealthCheck() {
  if (healthTimer) clearTimeout(healthTimer);
  healthTimer = null;
}

module.exports = { startHealthCheck, stopHealthCheck };
