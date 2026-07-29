"use strict";

const assert = require("node:assert/strict");
const { fork, spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EMERGENCY_ACTOR_ID, createCatalogStore, migrateLegacyCatalog, openDatabase
} = require("../lib/database");
const { runWorkerProcess } = require("../lib/isolated-worker");
const { createProcessingJobStore } = require("../lib/processing-jobs");
const { createResourceStore } = require("../lib/resources");
const { createUserStore } = require("../lib/users");

const ROOT = path.join(__dirname, "..");
const EMERGENCY = { actorUserId: EMERGENCY_ACTOR_ID, mode: "emergency-system" };

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-batch8a-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "app.sqlite");
  const catalogPath = path.join(directory, "resources.json");
  await fsp.writeFile(catalogPath, "[]\n");
  const db = openDatabase(databasePath);
  await migrateLegacyCatalog(db, catalogPath);
  t.after(() => {
    try { db.close(); } catch {}
  });
  const users = createUserStore(db);
  const admin = await users.createUser({
    loginIdentifier: "operator@example.test",
    displayName: "Operator",
    password: "OperatorPassword2026",
    role: "admin",
    operator: EMERGENCY
  });
  return { directory, databasePath, db, users, admin };
}

async function seedResource(value, id = "resource-8a") {
  const member = await value.users.createUser({
    loginIdentifier: `${id}@example.test`,
    displayName: "Affected Member",
    password: "MemberPassword2026",
    role: "member",
    operator: { actorUserId: value.admin.id }
  });
  createCatalogStore(value.db).replaceResources([{
    id,
    title: "Current title",
    category: "documents",
    sheetKind: "pdf",
    originalName: "source.pdf",
    storedName: `${id}.pdf`,
    extension: ".pdf",
    size: 10,
    uploadedAt: "2026-07-27T00:00:00.000Z",
    uploadedBy: member.id,
    updatedBy: member.id,
    searchStatus: "pending",
    searchText: "",
    annotations: []
  }], value.admin.id);
  return member;
}

function minimalPdf(text = "Choir") {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${33 + text.length} >>\nstream\nBT /F1 12 Tf 72 100 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

test("processing success, conflict retries, terminal failure, and later current completion", async (t) => {
  const value = await fixture(t);
  await seedResource(value);
  const resources = createResourceStore(value.db);
  const jobs = createProcessingJobStore(value.db);

  const successId = jobs.enqueue("resource-8a", value.admin.id, 2);
  const successJob = jobs.next();
  let current = value.db.prepare("SELECT * FROM resources WHERE id='resource-8a'").get();
  assert.equal(resources.updateSearchIndex(
    "resource-8a", current.updated_at,
    { searchText: "fresh content", searchStatus: "ready" }, value.admin.id
  ), true);
  jobs.succeed(successJob.id);
  assert.equal(value.db.prepare("SELECT status FROM processing_jobs WHERE id=?").get(successId).status,
    "succeeded");

  value.db.prepare(
    "UPDATE resources SET search_status='pending', search_text='', updated_at=? WHERE id='resource-8a'"
  ).run("2026-07-27T01:00:00.000Z");
  const conflictId = jobs.enqueue("resource-8a", value.admin.id, 2);
  const stale = jobs.next();
  const staleVersion = value.db.prepare(
    "SELECT updated_at FROM resources WHERE id='resource-8a'"
  ).get().updated_at;
  resources.updateMetadata("resource-8a", {
    title: "Changed concurrently", artist: "", key: "", capo: null, bpm: null, notes: "", tags: []
  }, value.admin.id);
  assert.equal(resources.updateSearchIndex(
    "resource-8a", staleVersion,
    { searchText: "STALE EXTRACTED CONTENT", searchStatus: "ready" }, value.admin.id
  ), false);
  const conflict = new Error("Resource changed while processing; retrying current version.");
  conflict.code = "PROCESSING_VERSION_CONFLICT";
  assert.equal(jobs.fail(stale.id, conflict), "queued");
  const retry = jobs.next();
  assert.equal(retry.id, conflictId);
  assert.equal(jobs.fail(retry.id, conflict), "failed");
  current = value.db.prepare("SELECT search_text, search_status FROM resources WHERE id='resource-8a'").get();
  assert.notEqual(current.search_text, "STALE EXTRACTED CONTENT");
  assert.equal(current.search_status, "pending");
  assert.equal(value.db.prepare(
    "SELECT COUNT(*) count FROM audit_events WHERE event_type='processing_version_conflict'"
  ).get().count, 2);

  const currentId = jobs.enqueue("resource-8a", value.admin.id, 2);
  const currentJob = jobs.next();
  current = value.db.prepare("SELECT updated_at FROM resources WHERE id='resource-8a'").get();
  assert.equal(resources.updateSearchIndex(
    "resource-8a", current.updated_at,
    { searchText: "current extracted content", searchStatus: "ready" }, value.admin.id
  ), true);
  jobs.succeed(currentJob.id);
  assert.equal(value.db.prepare("SELECT status FROM processing_jobs WHERE id=?").get(currentId).status,
    "succeeded");
  current = value.db.prepare("SELECT search_text, search_status FROM resources WHERE id='resource-8a'").get();
  assert.deepEqual(current, { search_text: "current extracted content", search_status: "ready" });
});

test("all CLI account mutations distinguish operator and affected user", async (t) => {
  const value = await fixture(t);
  const operator = { actorUserId: value.admin.id, mode: "administrator" };
  await assert.rejects(value.users.createUser({
    loginIdentifier: "missing@example.test", displayName: "Missing",
    password: "MissingPassword2026", role: "member"
  }), /operator attribution/);
  const affected = await value.users.createUser({
    loginIdentifier: "affected@example.test", displayName: "Affected",
    password: "AffectedPassword2026", role: "member", operator
  });
  value.users.setEnabled(affected.id, false, operator);
  value.users.setEnabled(affected.id, true, operator);
  await value.users.resetPassword(affected.id, "ReplacementPassword2026", {
    mustChangePassword: true, operator
  });
  value.users.setRole(affected.id, "admin", operator);
  const events = value.db.prepare(`
    SELECT actor_user_id, entity_id, event_type, details_json FROM audit_events
    WHERE entity_id=? AND event_type IN
      ('account_created','account_disabled','account_enabled','password_reset','role_changed')
    ORDER BY id
  `).all(affected.id);
  assert.deepEqual(events.map((row) => row.event_type), [
    "account_created", "account_disabled", "account_enabled", "password_reset", "role_changed"
  ]);
  for (const event of events) {
    assert.equal(event.actor_user_id, value.admin.id);
    assert.equal(event.entity_id, affected.id);
    assert.doesNotMatch(event.details_json, /ReplacementPassword2026/);
  }
  const emergencyEvent = value.db.prepare(`
    SELECT actor_user_id, details_json FROM audit_events
    WHERE event_type='account_created' AND entity_id=?
  `).get(value.admin.id);
  assert.equal(emergencyEvent.actor_user_id, EMERGENCY_ACTOR_ID);
  assert.equal(JSON.parse(emergencyEvent.details_json).operatorMode, "emergency-system");
});

test("account CLI rejects missing and conflicting operator modes", async (t) => {
  const value = await fixture(t);
  value.db.close();
  const baseArgs = ["lib/bootstrap.js", "disable-user", "--id", value.admin.id];
  const run = (extra) => new Promise((resolve) => {
    const child = spawn(process.execPath, [...baseArgs, ...extra], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: value.databasePath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("exit", (code) => resolve({ code, output }));
  });
  assert.match((await run([])).output, /exactly one/);
  assert.match((await run([
    "--operator", value.admin.id, "--emergency-system-actor"
  ])).output, /exactly one/);
});

test("SQLite lock beyond busy_timeout fails atomically and recovers", async (t) => {
  const value = await fixture(t);
  const child = fork(path.join(ROOT, "test/fixtures/hold-lock.js"), [
    value.databasePath, "6200"
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
  });
  const before = value.db.prepare("SELECT COUNT(*) count FROM app_metadata").get().count;
  const started = Date.now();
  assert.throws(() => value.db.prepare(
    "INSERT INTO app_metadata (key,value,updated_at) VALUES ('locked','x','2026-07-27')"
  ).run(), /database is locked/);
  assert.ok(Date.now() - started >= 4900);
  assert.equal(value.db.prepare("SELECT COUNT(*) count FROM app_metadata").get().count, before);
  await new Promise((resolve) => child.once("exit", resolve));
  value.db.prepare(
    "INSERT INTO app_metadata (key,value,updated_at) VALUES ('recovered','yes','2026-07-27')"
  ).run();
  assert.equal(value.db.prepare("SELECT value FROM app_metadata WHERE key='recovered'").get().value,
    "yes");
});

test("ENOSPC upload finalization leaves no row or finalized orphan", async (t) => {
  const value = await fixture(t);
  const member = await seedResource(value, "existing");
  const staged = path.join(value.directory, "staged.txt");
  const finalPath = path.join(value.directory, "uploads", "documents", "new.txt");
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  await fsp.writeFile(staged, "bytes");
  const resource = {
    id: "enospc-resource", title: "No space", artist: "", key: "", capo: null, bpm: null,
    notes: "", tags: [], category: "documents", sheetKind: "chart", originalName: "new.txt",
    storedName: "new.txt", extension: ".txt", size: 5,
    uploadedAt: "2026-07-27T02:00:00.000Z", searchText: "", searchStatus: "pending",
    indexedAt: null
  };
  const error = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  assert.throws(() => createResourceStore(value.db).createBatch(
    [resource], [{ stagedPath: staged, finalPath }], member.id,
    { beforeFileMove: () => { throw error; } }
  ), /no space/);
  assert.equal(fs.existsSync(finalPath), false);
  assert.equal(value.db.prepare("SELECT COUNT(*) count FROM resources WHERE id='enospc-resource'")
    .get().count, 0);
  assert.equal(value.db.prepare(`
    SELECT status FROM pending_operations WHERE operation_type='upload' ORDER BY created_at DESC
  `).get().status, "failed");
  assert.equal(fs.existsSync(staged), true);
  createResourceStore(value.db).createBatch(
    [resource], [{ stagedPath: staged, finalPath }], member.id
  );
  assert.equal(fs.existsSync(finalPath), true);
  assert.equal(value.db.prepare("SELECT search_status FROM resources WHERE id='enospc-resource'")
    .get().search_status, "pending");
});

test("forced worker timeout kills its descendant and temporary output is cleaned", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-timeout-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const pidPath = path.join(directory, "descendant.pid");
  const outputPath = path.join(directory, "temporary.output");
  try {
    await assert.rejects(runWorkerProcess({
      workerPath: path.join(ROOT, "test/fixtures/hanging-worker.js"),
      cwd: directory,
      message: { pidPath, outputPath },
      limits: {},
      timeoutMs: 250,
      envPath: process.env.PATH
    }), /timed out/);
  } finally {
    await fsp.unlink(outputPath).catch(() => undefined);
  }
  const pid = Number(await fsp.readFile(pidPath, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  let state;
  try {
    state = (await fsp.readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[2];
  } catch {
    state = "gone";
  }
  assert.ok(state === "gone" || state === "Z", `descendant remained active with state ${state}`);
  assert.equal(fs.existsSync(outputPath), false);
});

test("restart reports a pending upload without false success or unrelated cleanup", async (t) => {
  const value = await fixture(t);
  const uploads = path.join(value.directory, "uploads");
  const quarantine = path.join(value.directory, "quarantine");
  await Promise.all([uploads, quarantine].map((item) => fsp.mkdir(item, { recursive: true })));
  const unrelated = path.join(value.directory, "unrelated-recent");
  await fsp.writeFile(unrelated, "keep");
  value.db.close();
  const child = fork(path.join(ROOT, "test/fixtures/active-upload.js"), [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  child.send({
    databasePath: value.databasePath, directory: value.directory, actorId: value.admin.id
  });
  /** @type {any} */
  const interrupted = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const restarted = openDatabase(value.databasePath);
  const report = await createResourceStore(restarted).reportIntegrity({
    uploadsDir: uploads, stagingDir: value.directory, trashDir: quarantine
  });
  assert.equal(restarted.prepare(
    "SELECT COUNT(*) count FROM resources WHERE id='interrupted-resource'"
  ).get().count, 0);
  restarted.close();
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((item) =>
    item.type === "incomplete_operation" && item.id === interrupted.operationId
  ));
  assert.equal(fs.existsSync(interrupted.finalPath), false);
  assert.equal(fs.existsSync(interrupted.stagedPath), true);
  assert.equal(fs.existsSync(unrelated), true);
});

test("concurrent resource change rejects stale reindex and preserves live upload data", async (t) => {
  const value = await fixture(t);
  await seedResource(value);
  const store = createResourceStore(value.db);
  const stale = value.db.prepare("SELECT updated_at FROM resources WHERE id='resource-8a'").get();
  store.updateMetadata("resource-8a", {
    title: "Live concurrent title", artist: "", key: "", capo: null, bpm: null,
    notes: "", tags: []
  }, value.admin.id);
  assert.equal(store.updateSearchIndex(
    "resource-8a", stale.updated_at,
    { searchText: "stale", searchStatus: "ready" }, value.admin.id
  ), false);
  const current = value.db.prepare(
    "SELECT title, search_text FROM resources WHERE id='resource-8a'"
  ).get();
  assert.equal(current.title, "Live concurrent title");
  assert.notEqual(current.search_text, "stale");
});

test("missing thumbnail binary fails each PDF independently and browsing remains available", async (t) => {
  const value = await fixture(t);
  const member = await value.users.createUser({
    loginIdentifier: "pdf-owner@example.test", displayName: "PDF Owner",
    password: "PdfOwnerPassword2026", role: "member",
    operator: { actorUserId: value.admin.id }
  });
  const uploadDirectory = path.join(value.directory, "uploads", "documents");
  const thumbnailDirectory = path.join(value.directory, "thumbnails");
  await Promise.all([
    fsp.mkdir(uploadDirectory, { recursive: true }),
    fsp.mkdir(thumbnailDirectory, { recursive: true })
  ]);
  const resources = ["missing-bin-one", "missing-bin-two"].map((id) => ({
    id, title: id, category: "documents", sheetKind: "pdf",
    originalName: `${id}.pdf`, storedName: `${id}.pdf`, extension: ".pdf",
    size: minimalPdf(id).length, uploadedAt: "2026-07-27T03:00:00.000Z",
    uploadedBy: member.id, updatedBy: member.id, searchStatus: "pending",
    searchText: "", annotations: []
  }));
  createCatalogStore(value.db).replaceResources(resources, value.admin.id);
  for (const resource of resources) {
    await fsp.writeFile(path.join(uploadDirectory, resource.storedName), minimalPdf(resource.id));
  }
  const jobs = createProcessingJobStore(value.db);
  const store = createResourceStore(value.db);
  for (const resource of resources) jobs.enqueue(resource.id, value.admin.id, 2);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const job = jobs.next();
    assert.ok(job);
    const resource = value.db.prepare(`
      SELECT r.updated_at, f.stored_name FROM resources r
      JOIN resource_files f ON f.resource_id=r.id WHERE r.id=?
    `).get(job.resource_id);
    const error = await runWorkerProcess({
      workerPath: path.join(ROOT, "processing-worker.js"),
      cwd: value.directory,
      message: {
        action: "process",
        extension: ".pdf",
        filePath: path.join(uploadDirectory, resource.stored_name),
        thumbnailPath: path.join(thumbnailDirectory, job.resource_id)
      },
      limits: {
        pdfToPpmBin: path.join(value.directory, "definitely-missing-pdftoppm"),
        processTimeoutMs: 2000,
        childOutputBytes: 65536
      },
      timeoutMs: 3000,
      envPath: process.env.PATH
    }).then(() => null, (failure) => failure);
    assert.match(error.message, /ENOENT|not found|spawn/);
    const outcome = jobs.fail(job.id, error);
    if (outcome === "failed") {
      store.markProcessingFailed(
        job.resource_id, resource.updated_at, value.admin.id, "processing retry limit reached"
      );
    }
  }
  assert.deepEqual(value.db.prepare(
    "SELECT search_status FROM resources ORDER BY id"
  ).all().map((row) => row.search_status), ["failed", "failed"]);
  assert.equal(createCatalogStore(value.db).listResources().length, 2);
  assert.equal(value.db.prepare(
    "SELECT COUNT(*) count FROM processing_jobs WHERE status='failed'"
  ).get().count, 2);
});

test("paired backup, clean restore, application operations, and rollback rehearsal", async (t) => {
  const value = await fixture(t);
  const member = await seedResource(value, "backup-resource");
  const uploads = path.join(value.directory, "source-uploads");
  const stored = path.join(uploads, "documents", "backup-resource.pdf");
  await fsp.mkdir(path.dirname(stored), { recursive: true });
  await fsp.writeFile(stored, "representative source bytes");
  createResourceStore(value.db).createAnnotation("backup-resource", {
    id: "backup-annotation", page: 2, text: "Rehearsal note", color: "amber"
  }, member.id);
  const sourceHash = await (async () => {
    const hash = require("node:crypto").createHash("sha256");
    hash.update(await fsp.readFile(stored));
    return hash.digest("hex");
  })();
  value.db.close();

  const backupSet = path.join(value.directory, "paired-backup");
  const restoredDb = path.join(value.directory, "restored", "app.sqlite");
  const restoredUploads = path.join(value.directory, "restored-uploads");
  const runData = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/release-data.js", ...args], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => code === 0
      ? resolve(JSON.parse(stdout.trim()))
      : reject(new Error(stderr || stdout)));
  });
  const backupResult = await runData([
    "backup", "--quiesced", "--database", value.databasePath, "--uploads", uploads,
    "--output", backupSet,
    "--application-commit", "0123456789abcdef0123456789abcdef01234567",
    "--image-digest",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "--bundle-id", "20260729T031500Z-0123456789abcdef01234567",
    "--config-id", "config-previous"
  ]);
  assert.equal(backupResult.ok, true);
  const verifyResult = await runData([
    "verify", "--source", backupSet
  ]);
  assert.equal(verifyResult.ok, true);
  assert.equal(verifyResult.action, "verify");
  assert.equal(verifyResult.resourceCount, 1);
  assert.equal(verifyResult.uploadCount, 1);
  await fsp.writeFile(stored, "destroyed after backup");
  const restoreResult = await runData([
    "restore", "--source", backupSet, "--database", restoredDb, "--uploads", restoredUploads
  ]);
  assert.equal(restoreResult.ok, true);
  const restored = openDatabase(restoredDb);
  const restoredStore = createResourceStore(restored);
  assert.equal(restored.prepare("SELECT role FROM users WHERE id=?").get(member.id).role, "member");
  assert.equal(restored.prepare("SELECT COUNT(*) count FROM resources WHERE deleted_at IS NULL")
    .get().count, 1);
  assert.equal(restored.prepare("SELECT text FROM annotations WHERE id='backup-annotation'").get().text,
    "Rehearsal note");
  assert.ok(restored.prepare("SELECT COUNT(*) count FROM audit_events").get().count >= 3);
  assert.ok(await createUserStore(restored).authenticate(
    "backup-resource@example.test", "MemberPassword2026"
  ));
  const restoredBytes = await fsp.readFile(
    path.join(restoredUploads, "documents", "backup-resource.pdf")
  );
  const restoredHash = require("node:crypto").createHash("sha256")
    .update(restoredBytes).digest("hex");
  assert.equal(restoredHash, sourceHash);
  restoredStore.updateMetadata("backup-resource", {
    title: "Edited after restore", artist: "", key: "", capo: null, bpm: null,
    notes: "", tags: []
  }, member.id);
  const newStaged = path.join(value.directory, "new-after-restore.txt");
  const newFinal = path.join(restoredUploads, "documents", "new-after-restore.txt");
  await fsp.writeFile(newStaged, "new upload");
  restoredStore.createBatch([{
    id: "post-restore-upload", title: "New upload", artist: "", key: "", capo: null,
    bpm: null, notes: "", tags: [], category: "documents", sheetKind: "chart",
    originalName: "new.txt", storedName: "new-after-restore.txt", extension: ".txt",
    size: 10, uploadedAt: new Date().toISOString(), searchText: "", searchStatus: "pending",
    indexedAt: null
  }], [{ stagedPath: newStaged, finalPath: newFinal }], member.id);
  assert.equal(fs.existsSync(newFinal), true);
  restored.close();

  const previous = path.join(value.directory, "previous.json");
  const current = path.join(value.directory, "current.json");
  const rollbackPlan = path.join(value.directory, "rollback-plan.json");
  await fsp.writeFile(previous, JSON.stringify({
    release: "8A-previous", image: "mafusheets:previous", configId: "config-previous"
  }));
  await fsp.writeFile(current, JSON.stringify({
    release: "8A-failed", image: "mafusheets:failed", configId: "config-failed"
  }));
  const rollbackResult = await runData([
    "rollback", "--previous", previous, "--current", current, "--output", rollbackPlan
  ]);
  assert.equal(rollbackResult.plan.restoreRelease.image, "mafusheets:previous");
  assert.equal(rollbackResult.plan.failedRelease.image, "mafusheets:failed");
});
