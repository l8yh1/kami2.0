/**
 * Command: التحكم
 * Description: إدارة الغروبات وطلبات المراسلة
 * Admin only
 */

"use strict";

// ─── Session & motor state ────────────────────────────────────────────────────
const chatsSession = new Map();  // senderID → session
const motorData    = new Map();  // threadID → { status, message, time, interval }
const motorData2   = new Map();  // threadID → { status, message, time, interval } (smart)
const lastActivity = new Map();  // threadID → timestamp

// Export lastActivity so kami.js event handler can update it
module.exports.lastActivity = lastActivity;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getMotor(store, threadID) {
  if (!store.has(threadID)) {
    store.set(threadID, { status: false, message: null, time: null, interval: null });
  }
  return store.get(threadID);
}

function startMotor(api, threadID) {
  const data = getMotor(motorData, threadID);
  if (!data.message || !data.time) return;
  if (data.interval) { clearInterval(data.interval); data.interval = null; }
  data.status   = true;
  data.interval = setInterval(() => api.sendMessage(data.message, threadID), data.time);
}

function startMotor2(api, threadID) {
  const data = getMotor(motorData2, threadID);
  if (!data.message || !data.time) return;
  if (data.interval) { clearInterval(data.interval); data.interval = null; }
  data.status   = true;
  data.interval = setInterval(() => {
    const lastActive = lastActivity.get(threadID);
    if (!lastActive) return;
    if (Date.now() - lastActive < data.time * 2) {
      api.sendMessage(data.message, threadID);
    }
  }, data.time);
}

function stopMotor(threadID) {
  const data = motorData.get(threadID);
  if (data?.interval) { clearInterval(data.interval); data.interval = null; }
  if (data) data.status = false;
}

function stopMotor2(threadID) {
  const data = motorData2.get(threadID);
  if (data?.interval) { clearInterval(data.interval); data.interval = null; }
  if (data) data.status = false;
}

async function getThreadList(api, tags) {
  try {
    const result = await api.getThreadList(60, null, tags);
    return Array.isArray(result) ? result : (result?.data || []);
  } catch { return []; }
}

function timeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - Number(ts);
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "الآن";
  if (m < 60) return `${m}د`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}س`;
  return `${Math.floor(h / 24)}ي`;
}

function parseTime(input) {
  if (!input) return 0;
  if (input.endsWith("s")) return parseFloat(input) * 1000;
  if (input.endsWith("m")) return parseFloat(input) * 60 * 1000;
  return 0;
}

function sendMenu(api, threadID, senderID, messageID) {
  const menu =
    "💬 إدارة المحادثات\n" +
    "━━━━━━━━━━━━━━━\n" +
    "1 - طلبات المراسلة\n" +
    "2 - الغروبات الحالية\n" +
    "━━━━━━━━━━━━━━━\n" +
    "↩️ رد بالرقم لاختيار ما تريد";

  api.sendMessage(menu, threadID, (err, info) => {
    if (!err) {
      chatsSession.set(senderID, { step: "main", botMessageID: info.messageID });
    }
  }, messageID);
}

// ─── handleEvent (reply-based navigation) ────────────────────────────────────
module.exports.handleEvent = async function ({ api, event }) {
  const { senderID, threadID, messageReply, body, isGroup } = event;

  // Track activity for smart motor
  if (isGroup) lastActivity.set(threadID, Date.now());

  // Only process replies from admins that have an active session
  const session = chatsSession.get(senderID);
  if (!session) return;
  if (!messageReply) return;
  if (messageReply.messageID !== session.botMessageID) return;
  if (!body || !body.trim()) return;

  const input = body.trim();
  const { step } = session;

  // ─── Main menu ──────────────────────────────────────────────────────────
  if (step === "main") {

    if (input === "1") {
      api.sendMessage("⏳ جاري جلب طلبات المراسلة...", threadID);
      const pending  = await getThreadList(api, ["PENDING"]);
      const other    = await getThreadList(api, ["OTHER"]);
      const requests = [...pending, ...other].filter(r => r?.threadID);

      if (!requests.length)
        return api.sendMessage("📭 لا توجد طلبات مراسلة.", threadID);

      let msg = `📬 طلبات المراسلة (${requests.length})\n━━━━━━━━━━━━━━━\n`;
      const list = [];

      requests.slice(0, 20).forEach((r, i) => {
        const name = r.name || r.threadName || ("ID: " + r.threadID);
        const type = r.isGroup ? "👥" : "👤";
        msg += `${i + 1}. ${type} ${name}\n🆔 ${r.threadID}\n\n`;
        list.push({ threadID: r.threadID, name, isGroup: !!r.isGroup });
      });

      msg += "━━━━━━━━━━━━━━━\n↩️ رد برقم الطلب\n0 - قبول الكل";

      api.sendMessage(msg, threadID, (err, info) => {
        if (!err) chatsSession.set(senderID, { step: "request_list", list, botMessageID: info.messageID });
      });

    } else if (input === "2") {
      api.sendMessage("⏳ جاري جلب الغروبات...", threadID);
      const inbox  = await getThreadList(api, ["INBOX"]);
      const groups = inbox.filter(t => t?.isGroup && t?.threadID);

      if (!groups.length)
        return api.sendMessage("📭 البوت ليس في أي غروب.", threadID);

      groups.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

      let msg = `👥 الغروبات (${groups.length})\n━━━━━━━━━━━━━━━\n`;
      const list = [];

      groups.slice(0, 25).forEach((g, i) => {
        const name    = (g.name || g.threadName || ("ID: " + g.threadID)).slice(0, 25);
        const m1      = motorData.get(g.threadID)?.status ? "🟢" : "⚫";
        const m2      = motorData2.get(g.threadID)?.status ? "🟢" : "⚫";
        const members = g.participantIDs?.length || "?";
        const last    = timeAgo(g.timestamp);
        msg += `${i + 1}. ${name}\n👥${members} 🕐${last} M1:${m1} M2:${m2}\n🆔 ${g.threadID}\n\n`;
        list.push({ threadID: g.threadID, name });
      });

      msg += "━━━━━━━━━━━━━━━\nM1=محرك M2=محرك ذكي\n↩️ رد برقم الغروب";

      api.sendMessage(msg, threadID, (err, info) => {
        if (!err) chatsSession.set(senderID, { step: "group_list", list, botMessageID: info.messageID });
      });

    } else {
      api.sendMessage("⚠️ اختار 1 أو 2 فقط.", threadID);
    }
  }

  // ─── Request list ────────────────────────────────────────────────────────
  else if (step === "request_list") {
    const { list } = session;

    if (input === "0") {
      api.sendMessage(`⏳ جاري قبول ${list.length} طلب...`, threadID);
      let success = 0, failed = 0;
      for (const req of list) {
        try {
          await api.sendMessage("مرحباً 👋", req.threadID);
          success++;
          await new Promise(r => setTimeout(r, 500));
        } catch { failed++; }
      }
      return api.sendMessage(
        `✅ تم قبول ${success} طلب${failed > 0 ? ` · فشل ${failed}` : ""}`,
        threadID
      );
    }

    const idx = parseInt(input) - 1;
    if (isNaN(idx) || idx < 0 || idx >= list.length)
      return api.sendMessage("❌ رقم غير صحيح.", threadID);

    const selected = list[idx];
    const msg =
      `📨 ${selected.name}\n🆔 ${selected.threadID}\n━━━━━━━━━━━━━━━\n` +
      "1 - قبول الطلب\n" +
      "2 - رفض وحذف الطلب\n" +
      "3 - إرسال رسالة ثم قبول\n" +
      "━━━━━━━━━━━━━━━\n↩️ رد بالرقم";

    api.sendMessage(msg, threadID, (err, info) => {
      if (!err) chatsSession.set(senderID, { step: "request_action", selected, botMessageID: info.messageID });
    });
  }

  // ─── Request action ──────────────────────────────────────────────────────
  else if (step === "request_action") {
    const { selected } = session;

    if (input === "1") {
      try {
        await api.sendMessage("مرحباً! 👋", selected.threadID);
        api.sendMessage(`✅ تم قبول طلب "${selected.name}"`, threadID);
      } catch (e) {
        api.sendMessage(`❌ فشل: ${e.message?.slice(0, 100)}`, threadID);
      }
      chatsSession.delete(senderID);

    } else if (input === "2") {
      try {
        await api.deleteThread(selected.threadID);
        api.sendMessage(`🗑️ تم حذف طلب "${selected.name}"`, threadID);
      } catch (e) {
        api.sendMessage(`❌ فشل: ${e.message?.slice(0, 100)}`, threadID);
      }
      chatsSession.delete(senderID);

    } else if (input === "3") {
      api.sendMessage(
        `✏️ أرسل الرسالة التي تريد إرسالها لـ "${selected.name}":`,
        threadID,
        (err, info) => {
          if (!err) chatsSession.set(senderID, { step: "request_accept_msg", selected, botMessageID: info.messageID });
        }
      );

    } else {
      api.sendMessage("⚠️ اختار 1 أو 2 أو 3 فقط.", threadID);
    }
  }

  // ─── Custom accept message ────────────────────────────────────────────────
  else if (step === "request_accept_msg") {
    const { selected } = session;
    try {
      await api.sendMessage(input || "مرحباً! 👋", selected.threadID);
      api.sendMessage(`✅ تم قبول طلب "${selected.name}" وإرسال الرسالة.`, threadID);
    } catch (e) {
      api.sendMessage(`❌ فشل: ${e.message?.slice(0, 100)}`, threadID);
    }
    chatsSession.delete(senderID);
  }

  // ─── Group list ──────────────────────────────────────────────────────────
  else if (step === "group_list") {
    const idx = parseInt(input) - 1;
    const { list } = session;

    if (isNaN(idx) || idx < 0 || idx >= list.length)
      return api.sendMessage("❌ رقم غير صحيح.", threadID);

    const selected = list[idx];
    const tid = selected.threadID;
    const m1  = motorData.get(tid);
    const m2  = motorData2.get(tid);

    const msg =
      `👥 ${selected.name}\n🆔 ${tid}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📍 المحرك العادي: ${m1?.status ? "🟢 شغّال" : "⚫ متوقف"}\n` +
      `   📝 "${m1?.message || "لم تُضبط"}" · ⏱ ${m1?.time ? m1.time / 1000 + "s" : "—"}\n\n` +
      `📍 المحرك الذكي: ${m2?.status ? "🟢 شغّال" : "⚫ متوقف"}\n` +
      `   📝 "${m2?.message || "لم تُضبط"}" · ⏱ ${m2?.time ? m2.time / 1000 + "s" : "—"}\n` +
      `━━━━━━━━━━━━━━━\n` +
      "1 - تفعيل المحرك العادي\n" +
      "2 - إيقاف المحرك العادي\n" +
      "3 - ضبط رسالة المحرك العادي\n" +
      "4 - ضبط وقت المحرك العادي\n" +
      "5 - تفعيل المحرك الذكي\n" +
      "6 - إيقاف المحرك الذكي\n" +
      "7 - ضبط رسالة المحرك الذكي\n" +
      "8 - ضبط وقت المحرك الذكي\n" +
      "9 - إرسال رسالة للغروب\n" +
      "10 - إخراج البوت من الغروب\n" +
      "━━━━━━━━━━━━━━━\n↩️ رد بالرقم";

    api.sendMessage(msg, threadID, (err, info) => {
      if (!err) chatsSession.set(senderID, { step: "group_action", selected, botMessageID: info.messageID });
    });
  }

  // ─── Group action ─────────────────────────────────────────────────────────
  else if (step === "group_action") {
    const { selected } = session;
    const tid = selected.threadID;

    if (input === "1") {
      const d = motorData.get(tid);
      if (!d?.message) return api.sendMessage("❌ لم تُضبط رسالة المحرك. اختار 3 أولاً.", threadID);
      if (!d?.time)    return api.sendMessage("❌ لم يُضبط الوقت. اختار 4 أولاً.", threadID);
      startMotor(api, tid);
      api.sendMessage(`✅ تم تفعيل المحرك في "${selected.name}"`, threadID);
      chatsSession.delete(senderID);

    } else if (input === "2") {
      if (!motorData.get(tid)?.status)
        return api.sendMessage("⚠️ المحرك متوقف أصلاً.", threadID);
      stopMotor(tid);
      api.sendMessage(`✅ تم إيقاف المحرك في "${selected.name}"`, threadID);
      chatsSession.delete(senderID);

    } else if (input === "3") {
      api.sendMessage(
        `✏️ أرسل رسالة المحرك العادي في "${selected.name}":`,
        threadID,
        (err, info) => {
          if (!err) chatsSession.set(senderID, { step: "motor_set_msg", selected, motorType: 1, botMessageID: info.messageID });
        }
      );

    } else if (input === "4") {
      api.sendMessage(
        `⏱️ أرسل الوقت للمحرك العادي (مثال: 30s أو 2m):`,
        threadID,
        (err, info) => {
          if (!err) chatsSession.set(senderID, { step: "motor_set_time", selected, motorType: 1, botMessageID: info.messageID });
        }
      );

    } else if (input === "5") {
      const d = motorData2.get(tid);
      if (!d?.message) return api.sendMessage("❌ لم تُضبط رسالة المحرك الذكي. اختار 7 أولاً.", threadID);
      if (!d?.time)    return api.sendMessage("❌ لم يُضبط الوقت. اختار 8 أولاً.", threadID);
      startMotor2(api, tid);
      api.sendMessage(`✅ تم تفعيل المحرك الذكي في "${selected.name}"\n🔔 يرسل فقط عند وجود نشاط`, threadID);
      chatsSession.delete(senderID);

    } else if (input === "6") {
      if (!motorData2.get(tid)?.status)
        return api.sendMessage("⚠️ المحرك الذكي متوقف أصلاً.", threadID);
      stopMotor2(tid);
      api.sendMessage(`✅ تم إيقاف المحرك الذكي في "${selected.name}"`, threadID);
      chatsSession.delete(senderID);

    } else if (input === "7") {
      api.sendMessage(
        `✏️ أرسل رسالة المحرك الذكي في "${selected.name}":`,
        threadID,
        (err, info) => {
          if (!err) chatsSession.set(senderID, { step: "motor_set_msg", selected, motorType: 2, botMessageID: info.messageID });
        }
      );

    } else if (input === "8") {
      api.sendMessage(
        `⏱️ أرسل الوقت للمحرك الذكي (مثال: 30s أو 2m):`,
        threadID,
        (err, info) => {
          if (!err) chatsSession.set(senderID, { step: "motor_set_time", selected, motorType: 2, botMessageID: info.messageID });
        }
      );

    } else if (input === "9") {
      api.sendMessage(
        `💬 أرسل الرسالة التي تريد إرسالها إلى "${selected.name}":`,
        threadID,
        (err, info) => {
          if (!err) chatsSession.set(senderID, { step: "group_send_msg", selected, botMessageID: info.messageID });
        }
      );

    } else if (input === "10") {
      api.sendMessage(
        `⚠️ هل تريد إخراج البوت من "${selected.name}"؟\nأرسل "نعم" للتأكيد:`,
        threadID,
        (err, info) => {
          if (!err) chatsSession.set(senderID, { step: "group_leave_confirm", selected, botMessageID: info.messageID });
        }
      );

    } else {
      api.sendMessage("⚠️ اختار رقماً من 1 إلى 10.", threadID);
    }
  }

  // ─── Set motor message ────────────────────────────────────────────────────
  else if (step === "motor_set_msg") {
    const { selected, motorType } = session;
    if (!input) return api.sendMessage("❌ الرسالة فارغة.", threadID);
    const store = motorType === 1 ? motorData : motorData2;
    getMotor(store, selected.threadID).message = input;
    api.sendMessage(`✅ تم ضبط رسالة المحرك في "${selected.name}":\n"${input}"`, threadID);
    chatsSession.delete(senderID);
  }

  // ─── Set motor time ───────────────────────────────────────────────────────
  else if (step === "motor_set_time") {
    const { selected, motorType } = session;
    const ms = parseTime(input);
    if (!ms || ms < 5000)
      return api.sendMessage("❌ وقت غير صحيح. مثال: 30s أو 2m (الحد الأدنى 5s)", threadID);
    const store = motorType === 1 ? motorData : motorData2;
    getMotor(store, selected.threadID).time = ms;
    api.sendMessage(`✅ تم ضبط الوقت في "${selected.name}": ${input}`, threadID);
    chatsSession.delete(senderID);
  }

  // ─── Send message to group ────────────────────────────────────────────────
  else if (step === "group_send_msg") {
    const { selected } = session;
    if (!input) return api.sendMessage("❌ الرسالة فارغة.", threadID);
    try {
      await api.sendMessage(input, selected.threadID);
      api.sendMessage(`✅ تم إرسال الرسالة إلى "${selected.name}"`, threadID);
    } catch (e) {
      api.sendMessage(`❌ فشل الإرسال: ${e.message?.slice(0, 100)}`, threadID);
    }
    chatsSession.delete(senderID);
  }

  // ─── Leave group confirm ──────────────────────────────────────────────────
  else if (step === "group_leave_confirm") {
    const { selected } = session;
    if (input === "نعم") {
      try {
        await api.removeUserFromGroup(api.getCurrentUserID(), selected.threadID);
        api.sendMessage(`✅ خرج البوت من "${selected.name}"`, threadID);
      } catch (e) {
        api.sendMessage(`❌ فشل الخروج: ${e.message?.slice(0, 100)}`, threadID);
      }
    } else {
      api.sendMessage("❎ تم الإلغاء.", threadID);
    }
    chatsSession.delete(senderID);
  }
};

// ─── execute (entry point) ────────────────────────────────────────────────────
module.exports = {
  name: "التحكم",
  description: "إدارة الغروبات وطلبات المراسلة",
  adminOnly: true,
  handleEvent: module.exports.handleEvent,
  lastActivity,

  async execute({ api, event, threadID, senderID }) {
    chatsSession.set(senderID, { step: "main", botMessageID: null });

    const menu =
      "💬 إدارة المحادثات\n" +
      "━━━━━━━━━━━━━━━\n" +
      "1 - طلبات المراسلة\n" +
      "2 - الغروبات الحالية\n" +
      "━━━━━━━━━━━━━━━\n" +
      "↩️ رد بالرقم لاختيار ما تريد";

    api.sendMessage(menu, threadID, (err, info) => {
      if (!err) {
        const s = chatsSession.get(senderID);
        if (s) s.botMessageID = info.messageID;
      }
    });
  }
};
