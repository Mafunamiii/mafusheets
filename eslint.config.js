"use strict";

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "node_modules/**", "data/**", "uploads/**", "thumbnails/**", ".tmp/**",
      "backups/**", "playwright-report/**", "test-results/**", "audit*.json"
    ]
  },
  js.configs.recommended,
  {
    files: ["*.js", "lib/**/*.js", "scripts/**/*.js", "test/**/*.js", "playwright.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: globals.node
    },
    rules: {
      "no-empty": ["error", { "allowEmptyCatch": true }],
      // Filename validation intentionally uses an explicit C0-control range.
      "no-control-regex": "off",
      "preserve-caught-error": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }]
    }
  }
];
