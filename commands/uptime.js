/**
 * Command: ping
 * Description: Measures bot response latency
 */

"use strict";

module.exports = {
  name: "ping",
  description: "Measures bot response latency",
  adminOnly: false,

  async execute({ api, threadID, event }) {
    const sent = Date.now();

    api.sendMessage("🏓 Pong!", threadID, (err, msgInfo) => {
      if (err) return;
      const latency = Date.now() - sent;
      api.editMessage(`🏓 Pong! — ${latency}ms`, msgInfo.messageID);
    });
  }
};