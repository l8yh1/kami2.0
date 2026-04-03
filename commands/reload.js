/**
 * Command: reload
 * Description: Reloads the commands folder — picks up edits, new commands, and removed commands
 * Admin only
 */

"use strict";

const path = require("path");
const fs   = require("fs");

module.exports = {
  name: "reload",
  description: "Reloads all commands from the commands folder",
  adminOnly: true,

  async execute({ api, threadID, config }) {
    const commandsDir = path.resolve(config.commandsDir);
    const registry    = require(path.join(__dirname, "..", "commandRegistry"));

    const before = new Set(registry.commands.keys());
    let loaded = 0, updated = 0, removed = 0, failed = 0;
    const errors = [];

    // ── Find current .js files ──────────────────────────────────────────
    const files = fs.readdirSync(commandsDir).filter(f => f.endsWith(".js"));
    const seen  = new Set();

    for (const file of files) {
      const filePath = path.join(commandsDir, file);

      // Skip reload.js itself to avoid self-reload issues
      if (file === "reload.js") {
        seen.add("reload");
        continue;
      }

      try {
        // Bust require cache so edits are picked up
        delete require.cache[require.resolve(filePath)];
        const cmd = require(filePath);

        if (!cmd || typeof cmd.execute !== "function" || !cmd.name) {
          failed++;
          errors.push(`${file}: missing name or execute()`);
          continue;
        }

        const cmdName = cmd.name.toLowerCase();
        seen.add(cmdName);

        const isNew = !before.has(cmdName);

        // Register into shared registry
        registry.commands.set(cmdName, cmd);

        if (Array.isArray(cmd.keywords)) {
          for (const kw of cmd.keywords) {
            registry.keywords.set(kw.toLowerCase(), cmd);
          }
        }

        isNew ? loaded++ : updated++;
      } catch (e) {
        failed++;
        errors.push(`${file}: ${e.message}`);
      }
    }

    // ── Remove deleted commands ─────────────────────────────────────────
    for (const name of before) {
      if (name === "reload") continue;
      if (!seen.has(name)) {
        registry.commands.delete(name);
        removed++;
      }
    }

    // ── Clean up orphaned keywords ──────────────────────────────────────
    for (const [kw, cmd] of registry.keywords) {
      if (!registry.commands.has(cmd.name?.toLowerCase())) {
        registry.keywords.delete(kw);
      }
    }

    // ── Build reply ─────────────────────────────────────────────────────
    const lines = [`🔄 Reload complete`];
    if (loaded)  lines.push(`✅ New: ${loaded}`);
    if (updated) lines.push(`♻️ Updated: ${updated}`);
    if (removed) lines.push(`🗑️ Removed: ${removed}`);
    if (failed)  lines.push(`❌ Failed: ${failed}`);
    if (errors.length) lines.push(`\nErrors:\n${errors.map(e => `• ${e}`).join("\n")}`);
    if (!loaded && !updated && !removed && !failed) lines.push("Nothing changed.");

    api.sendMessage(lines.join("\n"), threadID);
  }
};