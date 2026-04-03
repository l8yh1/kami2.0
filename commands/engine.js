/**
 * Command: محرك
 * Description: إرسال رسالة تلقائية كل فترة زمنية محددة
 * Admin only
 */

"use strict";

// Per-thread motor state
const motorData = new Map();

function getThreadData(threadID) {
  if (!motorData.has(threadID)) {
    motorData.set(threadID, {
      status:   false,
      message:  null,
      time:     null,
      interval: null
    });
  }
  return motorData.get(threadID);
}

function parseTime(input) {
  if (!input) return null;
  if (input.endsWith("s")) {
    const ms = parseFloat(input) * 1000;
    return isNaN(ms) ? null : ms;
  }
  if (input.endsWith("m")) {
    const ms = parseFloat(input) * 60 * 1000;
    return isNaN(ms) ? null : ms;
  }
  return null;
}

module.exports = {
  name: "محرك",
  description: "إرسال رسالة تلقائية كل فترة زمنية محددة",
  adminOnly: true,

  async execute({ api, event, args, threadID }) {
    const sub = args[0];

    if (!sub) {
      return api.sendMessage(
        "📌 الاستخدام:\n" +
        "/محرك تفعيل\n" +
        "/محرك ايقاف\n" +
        "/محرك رسالة [النص]\n" +
        "/محرك وقت [مثال: 30s أو 0.5m]",
        threadID
      );
    }

    const data = getThreadData(threadID);

    // ── رسالة المحرك ────────────────────────────────────────────────────
    if (sub === "رسالة") {
      const msg = args.slice(1).join(" ").trim();
      if (!msg) {
        return api.sendMessage(
          "⚠️ اكتب الرسالة بعد الأمر.\nمثال: /محرك رسالة اهلا",
          threadID
        );
      }
      data.message = msg;
      return api.sendMessage(`✅ تم حفظ رسالة المحرك:\n"${msg}"`, threadID);
    }

    // ── وقت المحرك ──────────────────────────────────────────────────────
    if (sub === "وقت") {
      const input = args[1];
      if (!input) {
        return api.sendMessage(
          "⚠️ حدد الوقت.\nمثال: /محرك وقت 30s أو /محرك وقت 0.5m",
          threadID
        );
      }

      const ms = parseTime(input);
      if (!ms) {
        return api.sendMessage(
          "⚠️ صيغة الوقت غير صحيحة.\nاستخدم s للثواني أو m للدقائق.\nمثال: 30s أو 0.5m",
          threadID
        );
      }
      if (ms < 5000) {
        return api.sendMessage("⚠️ الحد الأدنى للوقت هو 5 ثواني.", threadID);
      }

      data.time = ms;
      return api.sendMessage(`✅ تم حفظ وقت المحرك: ${input}`, threadID);
    }

    // ── تفعيل المحرك ────────────────────────────────────────────────────
    if (sub === "تفعيل") {
      if (data.status) {
        return api.sendMessage("⚠️ المحرك مفعل مسبقاً.", threadID);
      }
      if (!data.message) {
        return api.sendMessage(
          "⚠️ لم تحدد رسالة المحرك بعد.\nاستخدم: /محرك رسالة [النص]",
          threadID
        );
      }
      if (!data.time) {
        return api.sendMessage(
          "⚠️ لم تحدد وقت المحرك بعد.\nاستخدم: /محرك وقت [مثال: 30s]",
          threadID
        );
      }

      data.status   = true;
      data.interval = setInterval(() => {
        api.sendMessage(data.message, threadID);
      }, data.time);

      return api.sendMessage(
        `✅ تم تفعيل المحرك.\n📝 الرسالة: "${data.message}"\n⏱ كل: ${data.time / 1000}s`,
        threadID
      );
    }

    // ── ايقاف المحرك ────────────────────────────────────────────────────
    if (sub === "ايقاف") {
      if (!data.status) {
        return api.sendMessage("⚠️ المحرك غير مفعل أصلاً.", threadID);
      }

      clearInterval(data.interval);
      data.status   = false;
      data.interval = null;
      return api.sendMessage("🔴 تم إيقاف المحرك.", threadID);
    }

    // ── حالة المحرك ─────────────────────────────────────────────────────
    if (sub === "حالة") {
      return api.sendMessage(
        `📊 حالة المحرك:\n` +
        `🔘 الحالة: ${data.status ? "✅ مفعل" : "🔴 موقف"}\n` +
        `📝 الرسالة: ${data.message || "غير محددة"}\n` +
        `⏱ الوقت: ${data.time ? `${data.time / 1000}s` : "غير محدد"}`,
        threadID
      );
    }

    // ── أمر غير معروف ───────────────────────────────────────────────────
    return api.sendMessage(
      "📌 الاستخدام:\n" +
      "/محرك تفعيل\n" +
      "/محرك ايقاف\n" +
      "/محرك رسالة [النص]\n" +
      "/محرك وقت [مثال: 30s أو 0.5m]\n" +
      "/محرك حالة",
      threadID
    );
  }
};
