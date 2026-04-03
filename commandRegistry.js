/**
 * commandRegistry.js
 * Shared mutable registry for commands and keywords.
 * Both kami.js and the reload command read/write from here.
 */

"use strict";

const registry = {
  commands: new Map(),
  keywords: new Map(),
};

module.exports = registry;
