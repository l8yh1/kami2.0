/**
 * Command: commands
 * Description: Lists all loaded bot commands
 */

"use strict";

const path     = require("path");
const registry = require(path.join(__dirname, "..", "commandRegistry"));

module.exports = {
  name: "commands",
  description: "Lists all loaded bot commands",
  adminOnly: false,

  async execute({ api, threadID, config, isAdmin }) {
    const prefix = config.prefix;

    const allCmds = [...registry.commands.values()];

    const publicCmds = allCmds.filter(c => !c.adminOnly);
    const adminCmds  = allCmds.filter(c => c.adminOnly);

    const format = (cmd) => {
      const desc = cmd.description ? ` — ${cmd.description}` : "";
      return `${prefix}${cmd.name}${desc}`;
    };

    const lines = [];

    lines.push(`🤖 Kami v${config.bot.version} — Commands\n`);

    if (publicCmds.length) {
      lines.push("📌 Public:");
      publicCmds.forEach(c => lines.push(`  ${format(c)}`));
    }

    if (adminCmds.length) {
      lines.push("\n🔒 Admin only:");
      // Only show admin commands to admins
      if (isAdmin) {
        adminCmds.forEach(c => lines.push(`  ${format(c)}`));
      } else {
        lines.push(`  ${adminCmds.length} command(s) hidden`);
      }
    }

    if (registry.keywords.size) {
      lines.push(`\n💬 Keywords: ${[...registry.keywords.keys()].map(k => `"${k}"`).join(", ")}`);
    }

    api.sendMessage(lines.join("\n"), threadID);
  }
};