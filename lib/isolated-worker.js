"use strict";

const { fork } = require("node:child_process");

function runWorkerProcess({ workerPath, cwd, message, limits, timeoutMs, envPath }) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], {
      cwd,
      env: { NODE_ENV: "production", PATH: envPath || "" },
      execArgv: ["--max-old-space-size=192"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: process.platform !== "win32",
    });
    const terminate = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      terminate();
      finish(new Error("Processing timed out."));
    }, timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`Worker stopped unexpectedly (${signal || code}).`));
    });
    child.once("message", (response) => {
      /** @type {any} */
      const result = response;
      if (result && result.ok) finish(null, result.result);
      else finish(new Error(result && result.error || "Worker rejected the file."));
    });
    child.send({ ...message, limits });
  });
}

module.exports = { runWorkerProcess };
