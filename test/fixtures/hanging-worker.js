"use strict";

const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");

process.once("message", async (message) => {
  /** @type {any} */
  const request = message;
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  await fsp.writeFile(request.pidPath, String(descendant.pid));
  await fsp.writeFile(request.outputPath, "temporary worker output");
  setInterval(() => {}, 1000);
});
