# Kami 2.0 — Facebook Messenger Bot

## Overview
Kami is a Facebook Messenger bot powered by the `@neoaz07/nkxfca` library. It features a modular command architecture with advanced stealth and session-maintenance systems ported from the ZAO bot.

## Project Structure

```
kami.js              Main entry point — login, event routing, system wiring
config.json          All configuration settings
commandRegistry.js   Shared command/keyword registry (supports hot-reload)
appstate.json        Facebook session cookies (Tier 1)
appstate2.json       Facebook session cookies (Tier 2, optional)
appstate3.json       Facebook session cookies (Tier 3, optional)

commands/            Command modules (each exports execute + metadata)
  ai.js, commands.js, control.js, engine.js, ping.js, reload.js, uptime.js

includes/              ZAO-sourced systems (all linked and active)
  humanTyping.js       Human typing simulation — delays + typing indicator
  keepAlive.js         HTTP session pinger with cookie saving + dtsg refresh
  stealthEngine.js     Burst protection, night-mode slowdown, read-receipt jitter
  antiSuspension.js    Circuit breaker, volume limiting, suspension signal detection
  mqttHealthCheck.js   MQTT watchdog — restarts listener if silent too long
  tierSwitch.js        Multi-account tier switching (Tier 1 → 2 → 3 on session expiry)
  user-agents.js       Modern browser UA pool for stealth HTTP requests
  apiModernizer.js     THE MODERNIZER — replaces library's sendMessage/getThreadInfo/
                       getUserInfo/listenMqtt with /includes/ implementations
  nkxfcaPatcher.js     Runtime library patches (exit-handler safety, higher anti-susp limits)
  zaoCookiePatcher.js  Cookie auto-persist, false-positive suspension filter, getBotInfo shim
  accountHealthMonitor.js  Dual health: cookie scan every 5 min + send-failure watchdog
  checkLiveCookie.js   Validates Facebook session via 3 endpoint probes (HTTP)

sain/                ZAO bot source (reference, not active)
logs/                Runtime logs (events, health, messages)
```

## Key Systems (from ZAO)

### Human Typing (`includes/humanTyping.js`)
Wraps `api.sendMessage` to simulate realistic typing speed based on message length, time of day, and configurable parameters. Shows typing indicator before sending.
Config key: `humanTyping`

### Keep-Alive (`includes/keepAlive.js`)
Pings Facebook via HTTP every 5–10 minutes with rotating endpoints and modern browser headers. Also saves cookies periodically and refreshes the `fb_dtsg` token.
Config key: `keepAlive`

### Stealth Engine (`includes/stealthEngine.js`)
Provides burst protection (throttles responses to rapid message floods), night-mode slowdown (1am–6am), and randomized read receipt timing.
Config key: `stealthMode`

### Anti-Suspension (`includes/antiSuspension.js`)
Monitors for suspension signals in errors, trips a circuit breaker after repeated signals, enforces thread throttling and adaptive delays, and supports warmup mode.

### MQTT Health Check (`includes/mqttHealthCheck.js`)
Watches MQTT activity. If the listener goes silent beyond `silentTimeoutMinutes`, restarts it automatically with exponential backoff. Notifies admins on failure.
Config key: `mqttHealthCheck`

### API Modernizer (`includes/apiModernizer.js`)
The core "use /includes instead of the library" module. After login it wraps the raw FCA api object in-place:
- `sendMessage` → rate-limiting queue (max 4 concurrent, 45 sends/min), anti-suspension pre-flight, human typing
- `getThreadInfo` / `getUserInfo` → in-memory + disk cache (avoids duplicate FB calls)
- `listenMqtt` → MQTT auto-reconnect with exponential backoff, feeds into `_restartListener`
- Also wires circuit-breaker controls onto `global.nkx`, enables warmup mode, broadcasts health every 15 min, auto-refreshes `fb_dtsg` token every 45–75 min
Config key: `nkxModern`

### Library Patcher (`includes/nkxfcaPatcher.js`)
Applied at startup before login:
- Prevents the library from registering its own `process.exit` / `uncaughtException` handlers (which would kill the bot before tier switching can save state)
- After login: raises the library's built-in anti-suspension limits from 1,500/day → 10,000/day and 220/hr → 600/hr

### Cookie Patcher (`includes/zaoCookiePatcher.js`)
Applied after login:
- Filters false-positive suspension signals ("something went wrong", "please try again later", etc.) from the library's circuit-breaker
- Hooks `getAppState()` to auto-persist cookies to disk on every refresh
- Adds a `getBotInfo()` shim for sessions that don't have it
- Guards `setOptions()` so required flags (`listenEvents`, `autoReconnect`) are never accidentally overridden

### Account Health Monitor (`includes/accountHealthMonitor.js`)
Two independent health signals watched simultaneously:
- Cookie scan every 5 min via HTTP (uses `checkLiveCookie.js`) — if session confirmed dead, triggers `_triggerAutoRelogin`
- Send-failure watchdog — if 3 non-auth send errors occur within 5 min, triggers `forceTierSwitch`
- Hourly health status broadcast to admins (uptime, tier, last cookie scan result, error count)

### Live Cookie Check (`includes/checkLiveCookie.js`)
Validates a Facebook session by probing mbasic.facebook.com, facebook.com/home.php, and m.facebook.com in sequence. Returns `true` (alive), `false` (dead/login redirect), or `null` (uncertain/network error).

### Tier Switching (`includes/tierSwitch.js`)
When a session expires, automatically tries to re-login using the current tier's cookie file, then advances to Tier 2 or 3 if the current tier is exhausted. Notifies admins and restarts the process on success.
Tier files: `appstate.json` → `appstate2.json` → `appstate3.json`

## Running
```
npm start
```

## Dependencies
- `@neoaz07/nkxfca` — Facebook API library
- `string-similarity` — fuzzy command matching
- `axios` — HTTP requests for keep-alive pings
- `fs-extra` — atomic file writes for cookie saving
