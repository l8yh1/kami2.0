"use strict";

const SUSPENSION_SIGNALS = [
    'checkpoint', 'action_required', 'account_locked', 'account locked',
    'device_login', 'account suspension', 'account suspended',
    'account has been suspended', 'account has been disabled',
    'your account has been disabled', 'this account has been suspended',
    'account banned', 'account has been banned', 'unusual_activity',
    'unusual activity', 'we noticed unusual activity', 'suspicious activity',
    'verify_your_account', 'verify your account', 'confirm_your_identity',
    'confirm your identity', 'confirm it\'s you', 'confirm its you',
    'please verify your account', 'please confirm your identity',
    'identity confirmation', 'security_check', 'security check required',
    'login_approvals', 'login approvals', 'two-factor authentication required',
    'too_many_requests', 'too many requests', 'rate limited', 'rate_limit',
    'temporarily blocked', 'temporarily_blocked',
    'your account has been temporarily blocked', 'please try again later',
    'feature temporarily blocked', 'feature temporarily unavailable',
    'something went wrong', 'automated behavior', 'not a human', 'bot detected',
    'automated_behavior', 'bot_detected', 'spam detected', 'spam_detected',
    'looks like spam', 'violates our community standards',
    'community standards violation', 'this content isn\'t available',
    'you\'re blocked from', 'blocked from sending', 'disabled for violating',
    'policy violation', 'action blocked', 'session expired',
    'session has expired', 'not logged in', 'login required',
    'authentication required', 'invalid session', 'please log in again',
    'your session has ended'
];

class AntiSuspension {
    constructor() {
        this.activityThrottler = new Map();
        this.lastActivity      = new Map();
        this.typing            = new Map();

        this.messageDelayMs   = 1200;
        this.threadDelayMs    = 2500;
        this.loginAttempts    = 0;
        this.maxLoginAttempts = 3;
        this.loginCooldown    = 300000;

        this.suspensionCircuitBreaker = {
            tripped:              false,
            trippedAt:            null,
            cooldownMs:           45 * 60 * 1000,
            signalCount:          0,
            maxSignalsBeforeTrip: 2,
            lastSignalAt:         null
        };

        this.dailyStats = {
            date:            new Date().toDateString(),
            messageCount:    0,
            maxDailyMessages: 999999999,
            threadStats:     new Map()
        };

        this.hourlyBucket = {
            hour:       new Date().getHours(),
            count:      0,
            maxPerHour: 999999999
        };

        this.sessionFingerprint = null;

        this.warmup = {
            active:              false,
            startedAt:           null,
            durationMs:          20 * 60 * 1000,
            maxMessagesPerHour:  999999999
        };

        this._dailyResetInterval  = setInterval(() => this._resetDailyStatsIfNeeded(),  60 * 1000);
        this._hourlyResetInterval = setInterval(() => this._resetHourlyBucketIfNeeded(), 30 * 1000);

        process.on('exit',   () => this._clearIntervals());
        process.on('SIGINT',  () => this._clearIntervals());
        process.on('SIGTERM', () => this._clearIntervals());
    }

    _resetDailyStatsIfNeeded() {
        const today = new Date().toDateString();
        if (this.dailyStats.date !== today) {
            this.dailyStats.date         = today;
            this.dailyStats.messageCount = 0;
            this.dailyStats.threadStats.clear();
        }
    }

    _resetHourlyBucketIfNeeded() {
        const currentHour = new Date().getHours();
        if (this.hourlyBucket.hour !== currentHour) {
            this.hourlyBucket.hour  = currentHour;
            this.hourlyBucket.count = 0;
        }
    }

    _clearIntervals() {
        if (this._dailyResetInterval)  { clearInterval(this._dailyResetInterval);  this._dailyResetInterval  = null; }
        if (this._hourlyResetInterval) { clearInterval(this._hourlyResetInterval); this._hourlyResetInterval = null; }
    }

    _incrementDailyStats(threadID) {
        this.dailyStats.messageCount++;
        this.hourlyBucket.count++;
        if (threadID) {
            const ts = this.dailyStats.threadStats.get(String(threadID)) || { count: 0 };
            ts.count++;
            ts.lastActivity = Date.now();
            this.dailyStats.threadStats.set(String(threadID), ts);
        }
    }

    isDailyLimitReached()  { return this.dailyStats.messageCount >= this.dailyStats.maxDailyMessages; }
    isHourlyLimitReached() {
        const limit = this.warmup.active ? this.warmup.maxMessagesPerHour : this.hourlyBucket.maxPerHour;
        return this.hourlyBucket.count >= limit;
    }

    checkVolumeLimit(threadID) {
        if (this.isDailyLimitReached())  return `Daily message limit reached (${this.dailyStats.messageCount}/${this.dailyStats.maxDailyMessages}). Pausing to avoid suspension.`;
        if (this.isHourlyLimitReached()) {
            const limit = this.warmup.active ? this.warmup.maxMessagesPerHour : this.hourlyBucket.maxPerHour;
            return `Hourly message limit reached (${this.hourlyBucket.count}/${limit}). Pausing to avoid suspension.`;
        }
        return null;
    }

    enableWarmup() {
        this.warmup.active    = true;
        this.warmup.startedAt = Date.now();
        setTimeout(() => { this.warmup.active = false; }, this.warmup.durationMs);
    }

    lockSessionFingerprint(ua, secChUa, platform, locale, timezone) {
        if (!this.sessionFingerprint) {
            this.sessionFingerprint = { ua, secChUa, platform, locale, timezone, lockedAt: Date.now() };
        }
        return this.sessionFingerprint;
    }

    getSessionFingerprint() { return this.sessionFingerprint; }

    detectSuspensionSignal(text) {
        if (!text || typeof text !== 'string') return false;
        const lower = text.toLowerCase();
        const found = SUSPENSION_SIGNALS.some(signal => lower.includes(signal));
        if (found) this._onSuspensionSignalDetected();
        return found;
    }

    _onSuspensionSignalDetected() {
        const cb = this.suspensionCircuitBreaker;
        cb.signalCount++;
        cb.lastSignalAt = Date.now();
        if (cb.signalCount >= cb.maxSignalsBeforeTrip && !cb.tripped) {
            cb.tripped    = true;
            cb.trippedAt  = Date.now();
            const { utils } = this._getUtils();
            utils?.warn?.("AntiSuspension",
                `Circuit breaker TRIPPED after ${cb.signalCount} suspension signals. ` +
                `Pausing all activity for ${cb.cooldownMs / 60000} minutes.`);
        }
    }

    _getUtils() {
        const logger = global.loggeryuki;
        return {
            utils: {
                warn: (tag, msg) => {
                    try {
                        if (logger) logger.log([{ message: `[ ${tag} ]: `, color: ["red","cyan"] }, { message: msg, color: "yellow" }]);
                        else console.warn(`[${tag}]`, msg);
                    } catch (_) {}
                },
                info: (tag, msg) => {
                    try {
                        if (logger) logger.log([{ message: `[ ${tag} ]: `, color: ["red","cyan"] }, { message: msg, color: "white" }]);
                        else console.log(`[${tag}]`, msg);
                    } catch (_) {}
                }
            }
        };
    }

    isCircuitBreakerTripped() {
        const cb = this.suspensionCircuitBreaker;
        if (!cb.tripped) return false;
        const elapsed = Date.now() - cb.trippedAt;
        if (elapsed >= cb.cooldownMs) {
            cb.tripped = false; cb.signalCount = 0; cb.trippedAt = null;
            return false;
        }
        return true;
    }

    getCircuitBreakerRemainingMs() {
        const cb = this.suspensionCircuitBreaker;
        if (!cb.tripped) return 0;
        return Math.max(0, cb.cooldownMs - (Date.now() - cb.trippedAt));
    }

    tripCircuitBreaker(reason, durationMs) {
        const cb    = this.suspensionCircuitBreaker;
        cb.tripped   = true;
        cb.trippedAt = Date.now();
        if (durationMs) cb.cooldownMs = durationMs;
        cb.signalCount = cb.maxSignalsBeforeTrip;
        const { utils } = this._getUtils();
        utils?.warn?.("AntiSuspension",
            `Circuit breaker manually tripped: ${reason || 'manual'}. Cooldown: ${(cb.cooldownMs / 60000).toFixed(1)} min`);
    }

    resetCircuitBreaker() {
        this.suspensionCircuitBreaker.tripped    = false;
        this.suspensionCircuitBreaker.signalCount = 0;
        this.suspensionCircuitBreaker.trippedAt   = null;
    }

    async simulateTyping(threadID, messageLength = 50) {
        const wpm       = 22 + Math.random() * 18;
        const charsPerMs = (wpm * 5) / 60000;
        const typingDelay = Math.min(6000, Math.max(800, messageLength / charsPerMs));
        const jitter     = (Math.random() - 0.5) * 600;
        return Math.round(typingDelay + jitter);
    }

    async addSmartDelay() {
        const base   = 800 + Math.random() * 1800;
        const jitter = (Math.random() - 0.5) * 400;
        const total  = Math.max(600, base + jitter);
        await new Promise(resolve => setTimeout(resolve, total));
    }

    async addAdaptiveDelay(threadID) {
        const threadCount  = this.dailyStats.threadStats.get(String(threadID))?.count || 0;
        const globalCount  = this.dailyStats.messageCount;
        let base = 800;
        if (globalCount > 1000) base = 3000;
        else if (globalCount > 500)  base = 2000;
        else if (globalCount > 200)  base = 1400;
        if (threadCount > 30) base += 800;
        if (threadCount > 60) base += 1200;
        const jitter = Math.random() * base * 0.4;
        await new Promise(resolve => setTimeout(resolve, Math.max(600, base + jitter)));
    }

    async enforceThreadThrottling(threadID) {
        const lastTime       = this.lastActivity.get(String(threadID)) || 0;
        const timeSinceLastMsg = Date.now() - lastTime;
        const minInterval    = this.threadDelayMs + Math.random() * 1000;
        if (timeSinceLastMsg < minInterval) {
            await new Promise(resolve => setTimeout(resolve, minInterval - timeSinceLastMsg));
        }
        this.lastActivity.set(String(threadID), Date.now());
        return Date.now() - lastTime;
    }

    async enforceMessageRate() {
        await new Promise(resolve => setTimeout(resolve, this.messageDelayMs + Math.random() * 800));
    }

    getHumanizedHeaders() {
        const { randomUserAgent } = require('./user-agents');
        const fp = this.sessionFingerprint;
        const ua = fp ? { userAgent: fp.ua, secChUa: fp.secChUa, secChUaPlatform: fp.platform } : randomUserAgent();
        return {
            'User-Agent':                ua.userAgent,
            'Accept-Language':           (fp && fp.locale) || 'en-US,en;q=0.9',
            'Accept-Encoding':           'gzip, deflate, br',
            'DNT':                       '1',
            'Connection':                'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Ch-Ua':                 ua.secChUa || '',
            'Sec-Ch-Ua-Mobile':          '?0',
            'Sec-Ch-Ua-Platform':        ua.secChUaPlatform || '"Windows"',
            'Sec-Fetch-Dest':            'document',
            'Sec-Fetch-Mode':            'navigate',
            'Sec-Fetch-Site':            'none',
            'Cache-Control':             'max-age=0'
        };
    }

    rotateUserAgent() {
        const { randomUserAgent } = require('./user-agents');
        if (this.sessionFingerprint) return this.sessionFingerprint.ua;
        return randomUserAgent().userAgent;
    }

    trackLoginAttempt() {
        this.loginAttempts++;
        const isLocked = this.loginAttempts >= this.maxLoginAttempts;
        return { attempt: this.loginAttempts, isLocked, cooldownMs: isLocked ? this.loginCooldown : 0, nextAttemptAt: isLocked ? Date.now() + this.loginCooldown : null };
    }

    resetLoginAttempts() { this.loginAttempts = 0; }

    checkAccountHealth(lastError) {
        const isSuspected = lastError && SUSPENSION_SIGNALS.some(i => (lastError.message || '').toLowerCase().includes(i));
        if (isSuspected) this._onSuspensionSignalDetected();
        return {
            suspended:               isSuspected,
            circuitBreakerTripped:   this.isCircuitBreakerTripped(),
            dailyLimitReached:       this.isDailyLimitReached(),
            hourlyLimitReached:      this.isHourlyLimitReached(),
            lastCheck:               Date.now(),
            recommendedAction:       isSuspected ? 'WAIT_AND_RETRY' : 'CONTINUE',
            circuitBreakerRemainingMs: this.getCircuitBreakerRemainingMs()
        };
    }

    getRealisticActivityPattern() {
        const hour      = new Date().getHours();
        const isNight   = hour < 6 || hour >= 22;
        const isEvening = hour >= 19 && hour < 22;
        return {
            messageFrequency:    isNight ? 'low' : isEvening ? 'moderate' : 'normal',
            nextActionDelayMs:   isNight ? 12000 + Math.random() * 18000 : isEvening ? 3000 + Math.random() * 5000 : 1500 + Math.random() * 3500,
            isActiveHours:       !isNight,
            recommendedCooldown: isNight ? 20000 : isEvening ? 6000 : 3000
        };
    }

    async safeRetry(fn, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            if (this.isCircuitBreakerTripped()) throw new Error('Circuit breaker is tripped. Stopping retries to protect account.');
            try {
                return await fn();
            } catch (error) {
                const msg = (error.message || '').toLowerCase();
                const isSuspensionError = SUSPENSION_SIGNALS.some(s => msg.includes(s));
                if (isSuspensionError) { this._onSuspensionSignalDetected(); throw error; }
                if (i === maxRetries - 1) throw error;
                const delay = Math.pow(2, i + 1) * 1000 + Math.random() * 800;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    async batchOperations(operations) {
        const results = [];
        for (let i = 0; i < operations.length; i++) {
            if (this.isCircuitBreakerTripped()) throw new Error('Circuit breaker tripped during batch operation.');
            results.push(await this.safeRetry(() => operations[i]()));
            if (i < operations.length - 1) await this.addSmartDelay();
        }
        return results;
    }

    async prepareBeforeMessage(threadID, message) {
        if (this.isCircuitBreakerTripped()) {
            const remaining = this.getCircuitBreakerRemainingMs();
            const waitMs    = Math.min(remaining, 8000);
            if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        const volumeWarning = this.checkVolumeLimit(threadID);
        if (volumeWarning) {
            const { utils } = this._getUtils();
            utils?.warn?.("AntiSuspension", volumeWarning);
            await new Promise(resolve => setTimeout(resolve, 5000 + Math.random() * 3000));
        }
        await this.enforceThreadThrottling(threadID);
        await this.addAdaptiveDelay(threadID);
        this._incrementDailyStats(threadID);
    }

    getConfig() {
        return {
            messageDelayMs: this.messageDelayMs,
            threadDelayMs:  this.threadDelayMs,
            maxLoginAttempts: this.maxLoginAttempts,
            loginCooldownMs:  this.loginCooldown,
            circuitBreaker: { tripped: this.suspensionCircuitBreaker.tripped, signalCount: this.suspensionCircuitBreaker.signalCount, remainingMs: this.getCircuitBreakerRemainingMs() },
            dailyStats:  { messageCount: this.dailyStats.messageCount, maxDailyMessages: this.dailyStats.maxDailyMessages },
            hourlyStats: { count: this.hourlyBucket.count, maxPerHour: this.hourlyBucket.maxPerHour },
            warmupActive: this.warmup.active
        };
    }

    getTimeBasedDelay() {
        const h = new Date().getHours();
        if (h >= 23 || h <= 5) return 8000 + Math.random() * 12000;
        if (h >= 6  && h <= 9) return 1200 + Math.random() * 2500;
        if (h >= 12 && h <= 14) return 2500 + Math.random() * 4000;
        if (h >= 18 && h <= 22) return 900  + Math.random() * 2000;
        return 1500 + Math.random() * 3000;
    }

    async maybeSessionBreak() {
        const roll = Math.random();
        if (roll < 0.05) {
            const ms = 2 * 60 * 1000 + Math.random() * 4 * 60 * 1000;
            const { utils } = this._getUtils();
            utils?.info?.("AntiSuspension", `Session break: ${(ms / 60000).toFixed(1)} min (human behaviour)`);
            await new Promise(r => setTimeout(r, ms));
        } else if (roll < 0.15) {
            const ms = 20000 + Math.random() * 40000;
            await new Promise(r => setTimeout(r, ms));
        }
    }

    async antiPatternJitter() {
        const patterns = [
            () => 300 + Math.random() * 600,
            () => 800 + Math.random() * 1500,
            () => 2000 + Math.random() * 3000,
            () => 50  + Math.random() * 200
        ];
        const weights = [0.4, 0.35, 0.15, 0.10];
        const r = Math.random();
        let acc = 0;
        for (let i = 0; i < patterns.length; i++) {
            acc += weights[i];
            if (r <= acc) { await new Promise(resolve => setTimeout(resolve, patterns[i]())); return; }
        }
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
    }

    async simulateReadDelay(messageBody = "") {
        const len   = typeof messageBody === "string" ? messageBody.length : 30;
        const readMs = Math.min(6000, Math.max(500, len * 5 + 300 + Math.random() * 800));
        await new Promise(r => setTimeout(r, readMs));
    }

    async fullEvasionSequence(threadID, messageBody = "") {
        await this.simulateReadDelay(messageBody);
        await this.antiPatternJitter();
        if (Math.random() < 0.08) await this.maybeSessionBreak();
    }
}

const globalAntiSuspension = new AntiSuspension();

module.exports = { AntiSuspension, globalAntiSuspension, SUSPENSION_SIGNALS };
