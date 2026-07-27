"use strict";

const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const { openDatabase } = require("./database");
const { createResourceStore } = require("./resources");

async function main() {
  const root = path.join(__dirname, "..");
  const databasePath = process.env.DATABASE_PATH || path.join(root, "data", "mafusheets.sqlite");
  const uploadsDir = path.join(root, "uploads");
  const stagingDir = path.join(root, ".tmp", "staging");
  const trashDir = path.join(root, "data", "quarantine");
  let db;
  try {
    db = openDatabase(databasePath);
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      issues: [{ type: "database_open_failed", path: databasePath, error: error.message }]
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  try {
    if (process.argv.includes("--repair")) {
      for (const directory of [uploadsDir, stagingDir, trashDir]) {
        await fsp.mkdir(directory, { recursive: true });
      }
      db.prepare("DELETE FROM operation_locks WHERE expires_at<=?")
        .run(new Date().toISOString());
    }
    const store = createResourceStore(db);
    const operationIndex = process.argv.indexOf("--repair-operation");
    if (operationIndex !== -1) {
      const operationId = String(process.argv[operationIndex + 1] || "");
      if (!operationId) throw new Error("--repair-operation requires an operation ID.");
      const backupPath = `${databasePath}.pre-repair-${Date.now()}.sqlite`;
      db.prepare("VACUUM INTO ?").run(backupPath);
      fs.chmodSync(backupPath, 0o400);
      store.repairOperation(operationId);
    }
    const report = await store.reportIntegrity({
      uploadsDir, stagingDir, trashDir
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
