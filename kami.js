/**
 * ██╗  ██╗ █████╗ ███╗   ███╗██╗    ██████╗       ██████╗
 * ██║ ██╔╝██╔══██╗████╗ ████║██║    ╚════██╗      ██╔═████╗
 * █████╔╝ ███████║██╔████╔██║██║     █████╔╝      ██║██╔██║
 * ██╔═██╗ ██╔══██║██║╚██╔╝██║██║    ██╔═══╝       ████╔╝██║
 * ██║  ██╗██║  ██║██║ ╚═╝ ██║██║    ███████╗      ╚██████╔╝
 * ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝    ╚══════╝       ╚═════╝
 *
 * Kami 2.0 — Facebook Messenger Bot
 * Powered by nkxfca (NeoKEX FCA)
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Load config.json ─────────────────────────────────────────────────────────
const CONFIG_PATH = path.resolve(__dirname, "config.json");

if (!fs.existsSync(CONFIG_PATH)) {
  console.error("[KAMI] ❌  config.json not found. Please create it first.");
  process.exit(1);
}

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

CONFIG.appStatePath = path.resolve(__dirname, CONFIG.appStatePath);
CONFIG.commandsDir  = path.resolve(__dirname, CONFIG.commandsDir);
CONFIG.logsDir      = path.resolve(__dirname, CONFIG.logsDir);

// ─── Dependency check ────────────────────────────────────────────────────────
let login, globalAntiSuspension;
try {
  ({ login } = require("@neoaz07/nkxfca"));
  ({ globalAntiSuspension } = require("@neoaz07/nkxfca/src/utils/antiSuspension"));
} catch {
  console.error(
    "[KAMI] ❌  @neoaz07/nkxfca not found.\n" +
    "       Run:  npm install @neoaz07/nkxfca"
  );
  process.exit(1);
}

// ─── Colors ──────────────────────────────────────────────────────────────────
const RESET   = "\x1b[0m";
const CYAN    = "\x1b[36m";
const GREEN   = "\x1b[32m";
const YELLOW  = "\x1b[33m";
const RED     = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE    = "\x1b[34m";
const BOLD    = "\x1b[1m";
const DIM     = "\x1b[2m";

// ─── Logger ──────────────────────────────────────────────────────────────────
function tag(label, color = CYAN) {
  return `${color}${BOLD}[${label}]${RESET}`;
}

function log(label, msg, color = CYAN) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`${DIM}${ts}${RESET} ${tag(label, color)} ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeLog(filename, content) {
  ensureDir(CONFIG.logsDir);
  fs.appendFileSync(path.join(CONFIG.logsDir, filename), content + "\n", "utf8");
}

// ─── Admin helpers ────────────────────────────────────────────────────────────
function isAdmin(userID) {
  return (CONFIG.admins || []).includes(String(userID));
}

function getRoleLabel(userID) {
  return isAdmin(userID)
    ? `${YELLOW}${BOLD}[ADMIN]${RESET}`
    : `${DIM}[USER]${RESET}`;
}

// ─── Message logger ───────────────────────────────────────────────────────────
function logMessage({ senderID, senderName, threadID, body, type = "MSG" }) {
  const role     = getRoleLabel(senderID);
  const name     = senderName || senderID;
  const preview  = body.length > 80 ? body.slice(0, 80) + "…" : body;
  const color    = isAdmin(senderID) ? YELLOW : CYAN;

  log(type, `${role} ${color}${name}${RESET} ${DIM}(thread:${threadID})${RESET} » ${preview}`, color);

  const logLine = `[${new Date().toISOString()}] [${type}] [${isAdmin(senderID) ? "ADMIN" : "USER"}] ${name} (${senderID}) thread:${threadID} » ${body}`;
  writeLog("messages.log", logLine);
}

function logCommandReply({ cmdName, reply, threadID }) {
  const preview = typeof reply === "string"
    ? (reply.length > 80 ? reply.slice(0, 80) + "…" : reply)
    : "(non-text reply)";

  log("REPLY", `${MAGENTA}/${cmdName}${RESET} → ${DIM}thread:${threadID}${RESET} « ${preview}`, MAGENTA);

  writeLog("messages.log", `[${new Date().toISOString()}] [REPLY] /${cmdName} thread:${threadID} « ${typeof reply === "string" ? reply : "(non-text)"}`);
}

// ─── AppState helpers ────────────────────────────────────────────────────────
function loadAppState() {
  if (!fs.existsSync(CONFIG.appStatePath)) {
    log("KAMI", `appstate.json not found at ${CONFIG.appStatePath}`, RED);
    log("KAMI", "Export your Facebook cookies and save them as appstate.json", YELLOW);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG.appStatePath, "utf8"));
  } catch (e) {
    log("KAMI", `Failed to parse appstate.json: ${e.message}`, RED);
    process.exit(1);
  }
}

function backupAppState(api) {
  try {
    const state = api.getAppState();
    fs.writeFileSync(CONFIG.appStatePath, JSON.stringify(state, null, 2), "utf8");
    log("BACKUP", "AppState saved ✓", DIM + GREEN);
  } catch (e) {
    log("BACKUP", `Failed to save AppState: ${e.message}`, YELLOW);
  }
}

// ─── Shared registry (used by reload command too) ────────────────────────────
const registry = require("./commandRegistry");

// ─── Command loader ───────────────────────────────────────────────────────────
function loadCommands() {
  // Clear existing registry on (re)load
  registry.commands.clear();
  registry.keywords.clear();

  ensureDir(CONFIG.commandsDir);

  const files = fs.readdirSync(CONFIG.commandsDir).filter(f => f.endsWith(".js"));

  for (const file of files) {
    const filePath = path.join(CONFIG.commandsDir, file);
    try {
      // Bust cache so re-runs always get fresh code
      delete require.cache[require.resolve(filePath)];
      const cmd = require(filePath);

      if (!cmd || typeof cmd.execute !== "function") {
        log("LOADER", `Skipping ${file} — missing execute()`, YELLOW);
        continue;
      }

      if (cmd.name) {
        registry.commands.set(cmd.name.toLowerCase(), cmd);
        log("LOADER", `Loaded command: ${CONFIG.prefix}${cmd.name}${cmd.adminOnly ? " 🔒" : ""}`, GREEN);
      }

      if (Array.isArray(cmd.keywords)) {
        for (const kw of cmd.keywords) {
          registry.keywords.set(kw.toLowerCase(), cmd);
          log("LOADER", `Registered keyword: "${kw}"`, GREEN);
        }
      }
    } catch (e) {
      log("LOADER", `Error loading ${file}: ${e.message}`, RED);
    }
  }

  log("LOADER", `${registry.commands.size} command(s), ${registry.keywords.size} keyword(s) loaded`, CYAN);
  return registry;
}

// ─── E2EE setup ──────────────────────────────────────────────────────────────
function setupE2EE(api) {
  if (!CONFIG.bot.e2eeEnabled) return;
  try {
    api.e2ee.enable();
    const pubKey = api.e2ee.getPublicKey();
    log("E2EE", `Enabled. Public key:\n         ${pubKey}`, MAGENTA);
  } catch (e) {
    log("E2EE", `Failed to enable: ${e.message}`, RED);
  }
}

// ─── Anti-Suspension setup ───────────────────────────────────────────────────
function setupAntiSuspension() {
  if (CONFIG.bot.warmupOnStart) {
    globalAntiSuspension.enableWarmup();
    log("WARMUP", "Warmup mode active — rate limited to 25 msg/hr for 20 min", YELLOW);
  }
  const status = globalAntiSuspension.getConfig();
  log("ANTI-SUSP", `Circuit breaker: ${status.circuitBreakerTripped ? "TRIPPED ⛔" : "OK ✓"}`, GREEN);
}

// ─── Health monitor ───────────────────────────────────────────────────────────
function startHealthMonitor(api) {
  setInterval(() => {
    try {
      const h    = api.getHealthStatus();
      const line = JSON.stringify(h);
      log("HEALTH", line, DIM + CYAN);
      writeLog("health.log", `[${new Date().toISOString()}] ${line}`);
    } catch (e) {
      log("HEALTH", `Failed to fetch status: ${e.message}`, YELLOW);
    }
  }, CONFIG.bot.healthInterval);
}

// ─── Suspension signal check ─────────────────────────────────────────────────
function isSuspensionSignal(msg = "") {
  if (!CONFIG.antiSuspension.autoTripOnSignals) return false;
  return (CONFIG.antiSuspension.signals || []).some(p => new RegExp(p, "i").test(msg));
}

// ─── Wrapped sendMessage that logs replies ────────────────────────────────────
function sendAndLog(api, msg, threadID, cmdName) {
  api.sendMessage(msg, threadID);
  if (cmdName) logCommandReply({ cmdName, reply: msg, threadID });
}

// ─── Built-in admin commands ──────────────────────────────────────────────────
// These are all admin-only by design.
const BUILTINS = ["health", "circuitbreaker", "cb", "warmup", "e2ee", "lock"];

async function handleBuiltin(api, cmdName, args, threadID, senderID) {
  // /lock — toggle bot lock
  if (cmdName === "lock") {
    const sub = args[0];
    if (sub === "on") {
      CONFIG.bot.lock = true;
      sendAndLog(api, "🔒 Bot locked. Non-admins will be silently ignored.", threadID, "lock");
    } else if (sub === "off") {
      CONFIG.bot.lock = false;
      sendAndLog(api, "🔓 Bot unlocked. All users can use commands.", threadID, "lock");
    } else {
      sendAndLog(api, `🔒 Lock is currently: ${CONFIG.bot.lock ? "ON" : "OFF"}\nUsage: /lock on | /lock off`, threadID, "lock");
    }
    return true;
  }

  // /health
  if (cmdName === "health") {
    try {
      const h = api.getHealthStatus();
      sendAndLog(api, `🩺 Health Status\n${JSON.stringify(h, null, 2)}`, threadID, "health");
    } catch { /* ignore */ }
    return true;
  }

  // /circuitbreaker | /cb
  if (cmdName === "circuitbreaker" || cmdName === "cb") {
    const sub = args[0];
    if (sub === "trip") {
      const mins = parseInt(args[1]) || 30;
      globalAntiSuspension.tripCircuitBreaker("manual_pause", mins * 60_000);
      sendAndLog(api, `⛔ Circuit breaker tripped for ${mins} min.`, threadID, "circuitbreaker");
    } else if (sub === "reset") {
      globalAntiSuspension.resetCircuitBreaker();
      sendAndLog(api, "✅ Circuit breaker reset.", threadID, "circuitbreaker");
    } else {
      const cfg = globalAntiSuspension.getConfig();
      sendAndLog(api,
        `🔌 Circuit Breaker\nTripped: ${cfg.circuitBreakerTripped}\n${JSON.stringify(cfg, null, 2)}`,
        threadID, "circuitbreaker"
      );
    }
    return true;
  }

  // /warmup
  if (cmdName === "warmup") {
    globalAntiSuspension.enableWarmup();
    sendAndLog(api, "🌡️ Warmup mode enabled (25 msg/hr for 20 min).", threadID, "warmup");
    return true;
  }

  // /e2ee
  if (cmdName === "e2ee") {
    const sub = args[0];
    try {
      if (sub === "enable") {
        api.e2ee.enable();
        CONFIG.bot.e2eeEnabled = true;
        const pk = api.e2ee.getPublicKey();
        sendAndLog(api, `🔐 E2EE enabled.\nPublic key:\n${pk}`, threadID, "e2ee");
      } else if (sub === "disable") {
        api.e2ee.disable();
        CONFIG.bot.e2eeEnabled = false;
        sendAndLog(api, "🔓 E2EE disabled.", threadID, "e2ee");
      } else if (sub === "pair" && args[1] && args[2]) {
        api.e2ee.setPeerKey(args[1], args[2]);
        sendAndLog(api, `✅ Peer key set for thread ${args[1]}.`, threadID, "e2ee");
      } else if (sub === "unpair" && args[1]) {
        api.e2ee.clearPeerKey(args[1]);
        sendAndLog(api, `🗑️ Peer key cleared for thread ${args[1]}.`, threadID, "e2ee");
      } else if (sub === "status") {
        const hasPeer = api.e2ee.hasPeer(threadID);
        sendAndLog(api,
          `🔐 E2EE: ${CONFIG.bot.e2eeEnabled ? "ON" : "OFF"}\n` +
          `Peer key this thread: ${hasPeer ? "✅ Set" : "❌ Not set"}`,
          threadID, "e2ee"
        );
      } else {
        sendAndLog(api,
          `E2EE usage:\n` +
          `${CONFIG.prefix}e2ee enable\n` +
          `${CONFIG.prefix}e2ee disable\n` +
          `${CONFIG.prefix}e2ee pair <threadID> <peerKey>\n` +
          `${CONFIG.prefix}e2ee unpair <threadID>\n` +
          `${CONFIG.prefix}e2ee status`,
          threadID, "e2ee"
        );
      }
    } catch (e) {
      sendAndLog(api, `E2EE error: ${e.message}`, threadID, "e2ee");
    }
    return true;
  }

  return false; // not a builtin
}

// ─── Event router ────────────────────────────────────────────────────────────
async function handleEvent(api, event, commands, keywords) {
  const { type, threadID, senderID, body } = event;

  // ── Dispatch to command handleEvent hooks (e.g. session-based commands) ──
  for (const cmd of commands.values()) {
    if (typeof cmd.handleEvent === "function") {
      try { await cmd.handleEvent({ api, event }); } catch { /* ignore */ }
    }
  }

  if (type !== "message" && type !== "message_reply") {
    writeLog("events.log", `[${new Date().toISOString()}] ${type} | thread:${threadID} | sender:${senderID}`);
    return;
  }

  if (!body) return;

  const trimmed    = body.trim();
  const lower      = trimmed.toLowerCase();
  const senderName = event.senderName || event.author || senderID;
  const admin      = isAdmin(senderID);

  // ── Log all incoming messages ────────────────────────────────────────────
  logMessage({ senderID, senderName, threadID, body: trimmed });

  const context = { api, event, threadID, senderID, senderName, body: trimmed, config: CONFIG, isAdmin: admin };

  // ── Prefix commands ──────────────────────────────────────────────────────
  if (trimmed.startsWith(CONFIG.prefix)) {
    const parts   = trimmed.slice(CONFIG.prefix.length).trim().split(/\s+/);
    const cmdName = parts.shift().toLowerCase();
    const args    = parts;

    // /help — available to everyone
    if (cmdName === "help") {
      const cmdList = [...commands.keys()]
        .map(n => {
          const c = commands.get(n);
          return `${CONFIG.prefix}${n}${c.adminOnly ? " 🔒" : ""}`;
        })
        .join("\n");
      const kwList = [...keywords.keys()].map(k => `"${k}"`).join(", ");
      const reply =
        `🤖 ${CONFIG.bot.name} v${CONFIG.bot.version}\n\n` +
        `📌 Commands:\n${cmdList || "(none)"}\n\n` +
        `💬 Keywords: ${kwList || "(none)"}\n\n` +
        `⚙️ Admin built-ins 🔒:\n` +
        `${CONFIG.prefix}health\n` +
        `${CONFIG.prefix}circuitbreaker [trip|reset]\n` +
        `${CONFIG.prefix}warmup\n` +
        `${CONFIG.prefix}e2ee <sub>\n` +
        `${CONFIG.prefix}lock [on|off]\n\n` +
        `🔒 = admin only`;
      sendAndLog(api, reply, threadID, "help");
      return;
    }

    // ── Admin-only builtin commands ──────────────────────────────────────
    if (BUILTINS.includes(cmdName)) {
      if (!admin) {
        log("ACCESS", `🚫 ${senderName} (${senderID}) tried admin command /${cmdName}`, RED);
        writeLog("messages.log", `[${new Date().toISOString()}] [DENIED] ${senderName} (${senderID}) tried /${cmdName} thread:${threadID}`);
        if (!CONFIG.bot.lock) {
          api.sendMessage("🔒 This is an admin-only command.", threadID);
        }
        // if lock is on → silently ignore
        return;
      }
      log("CMD", `${YELLOW}${BOLD}[ADMIN]${RESET} ${YELLOW}${senderName}${RESET} » ${MAGENTA}/${cmdName}${RESET} ${args.join(" ")}`, YELLOW);
      await handleBuiltin(api, cmdName, args, threadID, senderID);
      return;
    }

    // ── Dynamic commands ─────────────────────────────────────────────────
    const cmd = commands.get(cmdName);
    if (!cmd) return;

    // Admin-only check for dynamic commands
    if (cmd.adminOnly && !admin) {
      log("ACCESS", `🚫 ${senderName} (${senderID}) tried admin command /${cmdName}`, RED);
      writeLog("messages.log", `[${new Date().toISOString()}] [DENIED] ${senderName} (${senderID}) tried /${cmdName} thread:${threadID}`);
      if (!CONFIG.bot.lock) {
        api.sendMessage("🔒 This is an admin-only command.", threadID);
      }
      return;
    }

    // Lock check for non-admins
    if (CONFIG.bot.lock && !admin) {
      log("LOCK", `🔒 Blocked ${senderName} (${senderID}) — bot is locked`, DIM);
      return;
    }

    log("CMD", `${getRoleLabel(senderID)} ${admin ? YELLOW : CYAN}${senderName}${RESET} » ${MAGENTA}/${cmdName}${RESET} ${args.join(" ")}`, admin ? YELLOW : CYAN);

    try {
      // Wrap sendMessage so replies get logged
      const originalSend = api.sendMessage.bind(api);
      const patchedApi   = Object.assign(Object.create(Object.getPrototypeOf(api)), api, {
        sendMessage: (msg, tid, ...rest) => {
          logCommandReply({ cmdName, reply: msg, threadID: tid || threadID });
          return originalSend(msg, tid, ...rest);
        }
      });

      await cmd.execute({ ...context, api: patchedApi, args });
    } catch (e) {
      log("CMD", `/${cmdName} threw: ${e.message}`, RED);
      api.sendMessage(`⚠️ Error in /${cmdName}: ${e.message}`, threadID);
    }
    return;
  }

  // ── Lock check for keyword triggers ─────────────────────────────────────
  if (CONFIG.bot.lock && !admin) return;

  // ── Keyword matching ─────────────────────────────────────────────────────
  for (const [kw, cmd] of keywords) {
    if (lower.includes(kw)) {
      if (cmd.adminOnly && !admin) {
        log("ACCESS", `🚫 ${senderName} tried admin keyword "${kw}"`, RED);
        if (!CONFIG.bot.lock) api.sendMessage("🔒 This is an admin-only command.", threadID);
        return;
      }

      log("KW", `${getRoleLabel(senderID)} ${admin ? YELLOW : CYAN}${senderName}${RESET} matched keyword ${BLUE}"${kw}"${RESET}`, BLUE);

      try {
        await cmd.execute({ ...context, args: [], matchedKeyword: kw });
      } catch (e) {
        log("KW", `keyword "${kw}" threw: ${e.message}`, RED);
      }
      return;
    }
  }
}

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner() {
  console.log(`
${CYAN}${BOLD}
  ██╗  ██╗ █████╗ ███╗   ███╗██╗    ██████╗       ██████╗
  ██║ ██╔╝██╔══██╗████╗ ████║██║    ╚════██╗      ██╔═████╗
  █████╔╝ ███████║██╔████╔██║██║     █████╔╝      ██║██╔██║
  ██╔═██╗ ██╔══██║██║╚██╔╝██║██║    ██╔═══╝       ████╔╝██║
  ██║  ██╗██║  ██║██║ ╚═╝ ██║██║    ███████╗      ╚██████╔╝
  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝    ╚══════╝       ╚═════╝
${RESET}${DIM}  v${CONFIG.bot.version}  ·  powered by nkxfca  ·  NeoKEX${RESET}
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  printBanner();

  const appState = loadAppState();
  loadCommands(); // populates registry.commands and registry.keywords

  setupAntiSuspension();

  log("KAMI", "Logging in to Facebook...", CYAN);

  login({ appState }, CONFIG.login, async (err, api) => {
    if (err) {
      log("LOGIN", `Failed: ${err.message || JSON.stringify(err)}`, RED);
      if (isSuspensionSignal(err.message)) {
        globalAntiSuspension.tripCircuitBreaker(
          "login_failure",
          CONFIG.antiSuspension.circuitBreakerCooldownMs
        );
        log("ANTI-SUSP", "Circuit breaker tripped due to login failure.", RED);
      }
      process.exit(1);
    }

    const selfID = api.getCurrentUserID();
    log("LOGIN", `Logged in ✓  (uid: ${selfID})`, GREEN);
    log("KAMI", `Admins: ${CONFIG.admins.length > 0 ? CONFIG.admins.join(", ") : "none configured"}`, YELLOW);
    log("KAMI", `Lock: ${CONFIG.bot.lock ? "🔒 ON" : "🔓 OFF"}`, CONFIG.bot.lock ? RED : GREEN);

    setupE2EE(api);
    startHealthMonitor(api);

    const backupTimer = setInterval(() => backupAppState(api), CONFIG.bot.backupInterval);

    const shutdown = (sig) => {
      log("KAMI", `${sig} received — saving session & exiting...`, YELLOW);
      clearInterval(backupTimer);
      backupAppState(api);
      try { api.logout(); } catch { /* best-effort */ }
      process.exit(0);
    };
    process.once("SIGINT",  () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));

    log("KAMI", "Listening for messages via MQTT...", GREEN);

    api.listenMqtt(async (err, event) => {
      if (err) {
        log("MQTT", `Error: ${err.message || JSON.stringify(err)}`, RED);
        if (isSuspensionSignal(err.message)) {
          globalAntiSuspension.tripCircuitBreaker(
            "mqtt_error",
            CONFIG.antiSuspension.circuitBreakerCooldownMs
          );
          log("ANTI-SUSP", "Circuit breaker tripped due to MQTT error.", RED);
        }
        return;
      }

      if (!event) return;

      try {
        await handleEvent(api, event, registry.commands, registry.keywords);
      } catch (e) {
        log("EVENT", `Unhandled error: ${e.message}`, RED);
      }
    });
  });
}

main().catch(e => {
  log("FATAL", e.message, RED);
  process.exit(1);
});
