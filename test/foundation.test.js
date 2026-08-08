"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EMERGENCY_ACTOR_ID,
  LEGACY_IMPORT_KEY,
  MIGRATION_ACTOR_ID,
  createCatalogStore,
  migrateLegacyCatalog,
  openDatabase
} = require("../lib/database");
const { hashPassword, verifyPassword } = require("../lib/passwords");
const { createUserStore } = require("../lib/users");
const EMERGENCY_OPERATOR = { actorUserId: EMERGENCY_ACTOR_ID, mode: "emergency-system" };

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-test-"));
  t.after(async () => fsp.rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "library.sqlite");
  const catalogPath = path.join(directory, "resources.json");
  const db = openDatabase(databasePath);
  t.after(() => {
    if (db.open) db.close();
  });
  return { catalogPath, databasePath, db, directory };
}

function legacyResource(overrides = {}) {
  return {
    id: "resource-1",
    title: "Legacy sheet",
    category: "documents",
    originalName: "legacy.pdf",
    storedName: "100-resource-1.pdf",
    extension: ".pdf",
    size: 123,
    uploadedAt: "2026-01-02T03:04:05.000Z",
    searchText: "legacy",
    searchStatus: "indexed",
    indexedAt: "2026-01-02T03:05:05.000Z",
    ...overrides
  };
}

test("clean database initialization enables schema and foreign keys", async (t) => {
  const { db, catalogPath } = await fixture(t);
  const result = await migrateLegacyCatalog(db, catalogPath);
  assert.equal(result.status, "initialized-empty");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, 7);
  assert.deepEqual(db.prepare("PRAGMA table_info(resources)").all()
    .filter((column) => column.name === "search_pages_json")
    .map((column) => ({ notnull: column.notnull, default: column.dflt_value })), [
    { notnull: 1, default: "'[]'" }
  ]);
  assert.equal(createCatalogStore(db).listResources().length, 0);
});

test("valid JSON migration preserves identity, path, ownership, and a read-only backup", async (t) => {
  const { db, catalogPath } = await fixture(t);
  await fsp.writeFile(catalogPath, JSON.stringify([legacyResource()]));
  const result = await migrateLegacyCatalog(db, catalogPath);
  assert.equal(result.imported, 1);
  const resource = createCatalogStore(db).listResources()[0];
  assert.equal(resource.id, "resource-1");
  assert.equal(resource.storedName, "100-resource-1.pdf");
  assert.equal(resource.uploadedBy, MIGRATION_ACTOR_ID);
  assert.equal(resource.updatedBy, MIGRATION_ACTOR_ID);
  assert.equal(fs.statSync(result.backupPath).mode & 0o222, 0);
});

test("malformed JSON aborts without becoming an empty successful library", async (t) => {
  const { db, catalogPath } = await fixture(t);
  await fsp.writeFile(catalogPath, "[{");
  await assert.rejects(migrateLegacyCatalog(db, catalogPath), /malformed JSON/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM resources").get().count, 0);
  assert.equal(db.prepare("SELECT value FROM app_metadata WHERE key=?").get(LEGACY_IMPORT_KEY), undefined);
});

test("duplicate IDs and conflicting paths are rejected", async (t) => {
  const one = await fixture(t);
  await fsp.writeFile(one.catalogPath, JSON.stringify([
    legacyResource(),
    legacyResource({ storedName: "other.pdf" })
  ]));
  await assert.rejects(migrateLegacyCatalog(one.db, one.catalogPath), /Duplicate legacy resource ID/);

  const two = await fixture(t);
  await fsp.writeFile(two.catalogPath, JSON.stringify([
    legacyResource(),
    legacyResource({ id: "resource-2" })
  ]));
  await assert.rejects(migrateLegacyCatalog(two.db, two.catalogPath), /Conflicting legacy file path/);
});

test("an empty JSON array is a valid empty migrated library", async (t) => {
  const { db, catalogPath } = await fixture(t);
  await fsp.writeFile(catalogPath, "[]\n");
  const result = await migrateLegacyCatalog(db, catalogPath);
  assert.equal(result.status, "migrated");
  assert.equal(result.imported, 0);
  assert.ok(result.backupPath);
});

test("passwords are hardened and verify without plaintext storage", async () => {
  const password = "ChoirMember2026";
  const hash = await hashPassword(password);
  assert.notEqual(hash, password);
  assert.match(hash, /^\$2[aby]\$/);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("WrongPassword2026", hash), false);
  await assert.rejects(hashPassword("short"), /at least 12/);
});

test("users retain roles and disabled users cannot authenticate", async (t) => {
  const { db } = await fixture(t);
  const users = createUserStore(db);
  const admin = await users.createUser({
    loginIdentifier: "director@example.test",
    displayName: "Choir Director",
    password: "DirectorAccount2026",
    role: "admin",
    operator: EMERGENCY_OPERATOR
  });
  const member = await users.createUser({
    loginIdentifier: "member@example.test",
    displayName: "Choir Member",
    password: "MemberAccount2026",
    role: "member",
    operator: { actorUserId: admin.id, mode: "administrator" }
  });
  assert.equal(admin.role, "admin");
  assert.equal(member.role, "member");
  assert.equal(await users.authenticate("member@example.test", "MemberAccount2026").then(Boolean), true);
  await assert.rejects(
    users.updateOwnProfile(member.id, "Updated Member", "WrongPassword2026"),
    /Current password/
  );
  const updatedMember = await users.updateOwnProfile(
    member.id, "Updated Member", "MemberAccount2026"
  );
  assert.equal(updatedMember.displayName, "Updated Member");
  const renamedMember = users.updateIdentity(member.id, {
    loginIdentifier: "renamed@example.test",
    displayName: "Renamed Member"
  }, { actorUserId: admin.id, mode: "administrator" });
  assert.equal(renamedMember.loginIdentifier, "renamed@example.test");
  assert.equal(renamedMember.displayName, "Renamed Member");
  assert.equal(await users.authenticate("renamed@example.test", "MemberAccount2026").then(Boolean), true);
  users.setEnabled(member.id, false, { actorUserId: admin.id, mode: "administrator" });
  assert.equal(await users.authenticate("renamed@example.test", "MemberAccount2026"), null);
  const stored = db.prepare("SELECT password_hash FROM users WHERE id=?").get(admin.id);
  assert.notEqual(stored.password_hash, "DirectorAccount2026");
});

test("self-registered accounts remain pending until an administrator approves them", async (t) => {
  const { db } = await fixture(t);
  const users = createUserStore(db);
  const admin = await users.createUser({
    loginIdentifier: "admin@example.test",
    displayName: "Administrator",
    password: "Administrator2026",
    role: "admin",
    operator: EMERGENCY_OPERATOR
  });
  const pending = await users.register({
    loginIdentifier: "pending@example.test",
    displayName: "Pending Member",
    password: "PendingMember2026"
  });
  assert.equal(pending.enabled, true);
  assert.equal(pending.approved, false);
  assert.equal((await users.authenticate(
    "pending@example.test", "PendingMember2026"
  )).approved, false);

  const approved = users.setApproved(pending.id, true, {
    actorUserId: admin.id,
    mode: "administrator"
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.approvedBy, admin.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM audit_events WHERE event_type='approval_changed'")
      .get().count,
    1
  );
});

test("resource ownership fields are enforced by foreign keys", async (t) => {
  const { db, catalogPath } = await fixture(t);
  await fsp.writeFile(catalogPath, JSON.stringify([legacyResource()]));
  await migrateLegacyCatalog(db, catalogPath);
  assert.throws(() => {
    db.prepare("UPDATE resources SET uploaded_by='missing-user' WHERE id='resource-1'").run();
  }, /FOREIGN KEY/);
});

test("legacy migration is idempotent", async (t) => {
  const { db, catalogPath } = await fixture(t);
  await fsp.writeFile(catalogPath, JSON.stringify([legacyResource()]));
  assert.equal((await migrateLegacyCatalog(db, catalogPath)).status, "migrated");
  assert.equal((await migrateLegacyCatalog(db, catalogPath)).status, "already-migrated");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM resources").get().count, 1);
});

test("migration transaction rolls back every inserted row on failure", async (t) => {
  const { db, catalogPath } = await fixture(t);
  await fsp.writeFile(catalogPath, JSON.stringify([legacyResource()]));
  await assert.rejects(
    migrateLegacyCatalog(db, catalogPath, {
      beforeCommit() {
        throw new Error("injected failure");
      }
    }),
    /injected failure/
  );
  assert.equal(db.prepare("SELECT COUNT(*) count FROM resources").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM users WHERE is_system=0").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_events").get().count, 0);
  assert.equal(db.prepare("SELECT value FROM app_metadata WHERE key=?").get(LEGACY_IMPORT_KEY), undefined);
  assert.equal((await migrateLegacyCatalog(db, catalogPath)).status, "migrated");
});
