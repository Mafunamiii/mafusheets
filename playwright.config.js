"use strict";

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  workers: 1,
  reporter: [["line"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3218",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "node test/browser-server.js",
    url: "http://127.0.0.1:3218/health",
    reuseExistingServer: false,
    timeout: 30000
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { browserName: "chromium", viewport: { width: 1280, height: 800 } }
    },
    {
      name: "chromium-mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true
      }
    }
  ]
});
