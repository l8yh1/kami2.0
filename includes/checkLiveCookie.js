"use strict";

const axios = require("axios");

/**
 * Validates a Facebook session by attempting to load user-specific pages.
 *
 * Strategy:
 *   1. Hit mbasic.facebook.com root — lightest, fastest signal.
 *   2. Fallback: hit www.facebook.com/home.php — standard desktop check.
 *   3. Fallback: hit m.facebook.com/ — mobile web as final arbiter.
 *   4. If all three fail for non-auth reasons (timeout, 5xx) → null (uncertain).
 *
 * @param {string} cookie     Cookie string "c_user=123; xs=456; ..."
 * @param {string} [userAgent]
 * @returns {Promise<boolean|null>}
 *   true  = session confirmed alive
 *   false = session confirmed dead (login redirect)
 *   null  = uncertain — network error, let FCA decide
 */
module.exports = async function checkLiveCookie(cookie, userAgent) {
  const UA = userAgent ||
    "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Mobile Safari/537.36";

  const DEAD_SIGNALS = [
    'id="login_form"',
    'id="loginbutton"',
    'action="/login/device-based/regular/login/',
    "/login/?next=",
    "/login/identify",
    "You must log in to continue",
    "checkpoint/?next=",
    'name="email"',
    'name="pass"',
    "Log into Facebook",
    "Log In to Facebook"
  ];

  const ALIVE_SIGNALS = [
    "/messages/",
    "/notifications/",
    'href="/profile.php',
    'content="fb://',
    "mbasic_logout_button",
    "/logout.php",
    "userLink",
    "composer_photo",
    "feed_story",
    "pagelet_bluebar",
    "home_stream",
    '"USER_ID"',
    "c_user"
  ];

  async function tryUrl(url) {
    try {
      const resp = await axios({
        url,
        method: "GET",
        maxRedirects: 5,
        timeout: 15000,
        headers: {
          cookie,
          "user-agent": UA,
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "upgrade-insecure-requests": "1",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none"
        },
        validateStatus: () => true
      });

      const html     = String(resp.data || "");
      const finalUrl = String(resp.request?.res?.responseUrl || resp.config?.url || url);

      if (/\/login[/?]/.test(finalUrl)) return false;
      if (DEAD_SIGNALS.some(s => html.includes(s))) return false;
      if (ALIVE_SIGNALS.some(s => html.includes(s))) return true;
      if (resp.status === 200) return true;
      return null;
    } catch (e) {
      return null;
    }
  }

  const r1 = await tryUrl("https://mbasic.facebook.com/");
  if (r1 === true) return true;

  const r2 = await tryUrl("https://www.facebook.com/home.php");
  if (r2 === true) return true;

  const r3 = await tryUrl("https://m.facebook.com/");
  if (r3 === true) return true;

  if (r1 === false && r2 === false && r3 === false) return false;

  return null;
};
