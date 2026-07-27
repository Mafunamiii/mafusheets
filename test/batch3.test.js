"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MIGRATION_ACTOR_ID,
  createCatalogStore,
  migrateLegacyCatalog,
  openDatabase
} = require("../lib/database");
const { createResourceStore } = require("../lib/resources");

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-batch3-"));
  const staging = path.join(root, "staging");
  const uploads = path.join(root, "uploads");
  const trash = path.join(root, "trash");
  await Promise.all([
    fsp.mkdir(staging, { recursive: true }),
    fsp.mkdir(path.join(uploads, "documents"), { recursive: true }),
    fsp.mkdir(trash, { recursive: true })
  ]);
  const catalogPath = path.join(root, "resources.json");
  await fsp.writeFile(catalogPath, "[]\n");
  const db = openDatabase(path.join(root, "app.sqlite"));
  await migrateLegacyCatalog(db, catalogPath);
  const store = createResourceStore(db);
  t.after(async () => {
    if (db.open) db.close();
    await fsp.rm(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  });
  return { root, staging, uploads, trash, db, store };
}

function resource(id, storedName) {
  const timestamp = new Date().toISOString();
  return {
    id,
    title: id,
    artist: "",
    key: "",
    capo: null,
    bpm: null,
    notes: "",
    tags: [],
    category: "documents",
    sheetKind: "pdf",
    originalName: `${id}.pdf`,
    storedName,
    extension: ".pdf",
    size: 4,
    uploadedAt: timestamp,
    searchText: "",
    searchStatus: "empty",
    indexedAt: timestamp
  };
}

async function stagedBatch(fixtureValue, count = 2) {
  const resources = [];
  const moves = [];
  for (let index = 0; index < count; index += 1) {
    const id = `resource-${index}`;
    const storedName = `${id}.pdf`;
    const stagedPath = path.join(fixtureValue.staging, `${id}.tmp`);
    const finalPath = path.join(fixtureValue.uploads, "documents", storedName);
    await fsp.writeFile(stagedPath, "data");
    resources.push(resource(id, storedName));
    moves.push({ stagedPath, finalPath });
  }
  return { resources, moves };
}

test("batch upload rolls back records and finalized files when a move fails", async (t) => {
  const value = await fixture(t);
  const batch = await stagedBatch(value);
  assert.throws(() => value.store.createBatch(
    batch.resources, batch.moves, MIGRATION_ACTOR_ID, {
      beforeFileMove(_move, index) {
        if (index === 1) throw new Error("injected move failure");
      }
    }
  ), /injected move failure/);
  assert.equal(value.db.prepare("SELECT COUNT(*) count FROM resources").get().count, 0);
  for (const move of batch.moves) {
    assert.equal(fs.existsSync(move.finalPath), false);
  }
});

test("staging and validation failures occur before database or final-file changes", async (t) => {
  const value = await fixture(t);
  let batch = await stagedBatch(value, 1);
  assert.throws(() => value.store.createBatch(
    batch.resources, batch.moves, MIGRATION_ACTOR_ID,
    { beforeStagingCheck() { throw new Error("staging failure"); } }
  ), /staging failure/);
  assert.equal(value.db.prepare("SELECT COUNT(*) count FROM resources").get().count, 0);
  assert.equal(fs.existsSync(batch.moves[0].finalPath), false);

  batch = await stagedBatch(value, 1);
  assert.throws(() => value.store.createBatch(
    batch.resources, batch.moves, MIGRATION_ACTOR_ID,
    { beforeValidation() { throw new Error("validation failure"); } }
  ), /validation failure/);
  assert.equal(value.db.prepare("SELECT COUNT(*) count FROM resources").get().count, 0);
  assert.equal(fs.existsSync(batch.moves[0].finalPath), false);
});

test("batch upload rolls back on database insert and thumbnail enqueue failures", async (t) => {
  const value = await fixture(t);
  let batch = await stagedBatch(value);
  assert.throws(() => value.store.createBatch(
    batch.resources, batch.moves, MIGRATION_ACTOR_ID,
    { beforeDatabaseInsert() { throw new Error("insert failure"); } }
  ), /insert failure/);
  assert.equal(value.db.prepare("SELECT COUNT(*) count FROM resources").get().count, 0);

  batch = await stagedBatch(value);
  assert.throws(() => value.store.createBatch(
    batch.resources, batch.moves, MIGRATION_ACTOR_ID,
    { beforeThumbnailEnqueue() { throw new Error("enqueue failure"); } }
  ), /enqueue failure/);
  assert.equal(value.db.prepare("SELECT COUNT(*) count FROM resources").get().count, 0);
  assert.equal(batch.moves.some((move) => fs.existsSync(move.finalPath)), false);
});

test("metadata and annotation writes are atomic and record actors and timestamps", async (t) => {
  const value = await fixture(t);
  const batch = await stagedBatch(value, 1);
  value.store.createBatch(batch.resources, batch.moves, MIGRATION_ACTOR_ID);
  const before = value.db.prepare("SELECT updated_at FROM resources WHERE id=?").get("resource-0");
  assert.throws(() => value.store.updateMetadata(
    "resource-0", {}, MIGRATION_ACTOR_ID,
    { beforeMetadataUpdate() { throw new Error("metadata failure"); } }
  ), /metadata failure/);
  assert.deepEqual(
    value.db.prepare("SELECT title, updated_at FROM resources WHERE id=?").get("resource-0"),
    { title: "resource-0", updated_at: before.updated_at }
  );
  value.store.updateMetadata("resource-0", {
    title: "changed", artist: "", key: "", capo: null, bpm: null, notes: "", tags: []
  }, MIGRATION_ACTOR_ID);
  const changed = value.db.prepare(
    "SELECT title, updated_by, updated_at FROM resources WHERE id=?"
  ).get("resource-0");
  assert.equal(changed.title, "changed");
  assert.equal(changed.updated_by, MIGRATION_ACTOR_ID);
  assert.ok(changed.updated_at);

  const annotation = value.store.createAnnotation("resource-0", {
    id: "annotation-1", page: 1, text: "note", color: "amber"
  }, MIGRATION_ACTOR_ID);
  assert.equal(annotation.userId, MIGRATION_ACTOR_ID);
  assert.throws(() => value.store.createAnnotation("resource-0", {
    id: "annotation-2", page: 1, text: "note", color: "amber"
  }, MIGRATION_ACTOR_ID, {
    beforeAnnotationWrite() { throw new Error("annotation failure"); }
  }), /annotation failure/);
  assert.equal(value.db.prepare("SELECT COUNT(*) count FROM annotations").get().count, 1);
});

test("replacement failure restores the original working file and database row", async (t) => {
  const value = await fixture(t);
  const batch = await stagedBatch(value, 1);
  value.store.createBatch(batch.resources, batch.moves, MIGRATION_ACTOR_ID);
  const replacementStage = path.join(value.staging, "replacement.tmp");
  const replacementFinal = path.join(value.uploads, "documents", "replacement.pdf");
  const backup = path.join(value.trash, "original.pdf");
  await fsp.writeFile(replacementStage, "new");
  assert.throws(() => value.store.replaceFile("resource-0", {
    stagedPath: replacementStage,
    finalPath: replacementFinal,
    originalPath: batch.moves[0].finalPath,
    backupPath: backup,
    category: "documents",
    originalName: "replacement.pdf",
    storedName: "replacement.pdf",
    extension: ".pdf",
    size: 3,
    sheetKind: "pdf",
    searchText: "",
    searchStatus: "empty"
  }, MIGRATION_ACTOR_ID, {
    beforeReplacementDatabaseUpdate() { throw new Error("replacement failure"); }
  }), /replacement failure/);
  assert.equal(await fsp.readFile(batch.moves[0].finalPath, "utf8"), "data");
  assert.equal(fs.existsSync(replacementFinal), false);
  const row = value.db.prepare(
    "SELECT stored_name FROM resource_files WHERE resource_id='resource-0'"
  ).get();
  assert.equal(row.stored_name, "resource-0.pdf");
});

test("deletion reports failure and retains retry metadata when cleanup fails", async (t) => {
  const value = await fixture(t);
  const batch = await stagedBatch(value, 1);
  value.store.createBatch(batch.resources, batch.moves, MIGRATION_ACTOR_ID);
  const quarantine = path.join(value.trash, "resource-0.pdf");
  const pending = value.store.deleteResource("resource-0", MIGRATION_ACTOR_ID, [{
    source: batch.moves[0].finalPath,
    quarantine,
    required: true
  }]);
  assert.throws(() => value.store.finalizeDeletion(
    pending.operationId, MIGRATION_ACTOR_ID, {
      beforeFilesystemDeletion() { throw new Error("filesystem deletion failure"); }
    }
  ), /filesystem deletion failure/);
  const operation = value.db.prepare(
    "SELECT status, details_json FROM pending_operations WHERE id=?"
  ).get(pending.operationId);
  assert.equal(operation.status, "failed");
  assert.match(operation.details_json, /quarantine/);
  assert.equal(fs.existsSync(quarantine), true);
});

test("database deletion failure restores quarantined files and leaves the resource live", async (t) => {
  const value = await fixture(t);
  const batch = await stagedBatch(value, 1);
  value.store.createBatch(batch.resources, batch.moves, MIGRATION_ACTOR_ID);
  const quarantine = path.join(value.trash, "resource-0-database-failure.pdf");
  assert.throws(() => value.store.deleteResource(
    "resource-0", MIGRATION_ACTOR_ID, [{
      source: batch.moves[0].finalPath,
      quarantine,
      required: true
    }], {
      beforeDatabaseDelete() { throw new Error("database deletion failure"); }
    }
  ), /database deletion failure/);
  assert.equal(fs.existsSync(batch.moves[0].finalPath), true);
  assert.equal(fs.existsSync(quarantine), false);
  assert.equal(
    value.db.prepare("SELECT deleted_at FROM resources WHERE id='resource-0'").get().deleted_at,
    null
  );
});

test("optimistic reindex cannot overwrite a concurrent live write", async (t) => {
  const value = await fixture(t);
  const batch = await stagedBatch(value, 1);
  value.store.createBatch(batch.resources, batch.moves, MIGRATION_ACTOR_ID);
  const snapshot = createCatalogStore(value.db).listResources()[0];
  value.store.updateMetadata("resource-0", {
    title: "live edit", artist: "", key: "", capo: null, bpm: null, notes: "", tags: []
  }, MIGRATION_ACTOR_ID);
  const committed = value.store.updateSearchIndex("resource-0", snapshot.updatedAt, {
    searchText: "stale", searchStatus: "indexed"
  }, MIGRATION_ACTOR_ID);
  assert.equal(committed, false);
  const row = value.db.prepare("SELECT title, search_text FROM resources WHERE id=?")
    .get("resource-0");
  assert.deepEqual(row, { title: "live edit", search_text: "" });
});

test("integrity report exposes missing files and incomplete operations without deleting data", async (t) => {
  const value = await fixture(t);
  const batch = await stagedBatch(value, 1);
  value.store.createBatch(batch.resources, batch.moves, MIGRATION_ACTOR_ID);
  await fsp.unlink(batch.moves[0].finalPath);
  const report = await value.store.reportIntegrity({
    uploadsDir: value.uploads,
    stagingDir: value.staging,
    trashDir: value.trash
  });
  assert.equal(report.ok, false);
  assert.equal(report.issues.some((issue) => issue.type === "missing_resource_file"), true);
  assert.equal(value.db.prepare("SELECT COUNT(*) count FROM resources").get().count, 1);
});
