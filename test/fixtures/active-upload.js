"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { openDatabase } = require("../../lib/database");
const { createResourceStore } = require("../../lib/resources");

process.once("message", async (message) => {
  /** @type {any} */
  const request = message;
  const db = openDatabase(request.databasePath);
  const stagedPath = path.join(request.directory, "active-upload.part");
  const finalPath = path.join(request.directory, "uploads", "documents", "active.txt");
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  await fsp.writeFile(stagedPath, "partial upload");
  createResourceStore(db).createBatch([{
    id: "interrupted-resource", title: "Interrupted", artist: "", key: "", capo: null,
    bpm: null, notes: "", tags: [], category: "documents", sheetKind: "chart",
    originalName: "active.txt", storedName: "active.txt", extension: ".txt", size: 14,
    uploadedAt: new Date().toISOString(), searchText: "", searchStatus: "pending", indexedAt: null
  }], [{ stagedPath, finalPath }], request.actorId, {
    afterPendingOperation(operationId) {
      if (process.send) process.send({ operationId, stagedPath, finalPath });
      // This fixture is test-only and deliberately suspends at the persisted pending boundary.
      while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  });
});
