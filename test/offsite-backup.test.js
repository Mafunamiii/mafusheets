"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const BetterSqlite3 = require("better-sqlite3");

const ROOT = path.resolve(__dirname, "..");
const RECEIVER = path.join(ROOT, "scripts", "offsite-backup-receive.py");
const RESTORE = path.join(ROOT, "scripts", "mafusheets-backup-restore");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT, encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, "scripts"),
      PYTHONDONTWRITEBYTECODE: "1"
    },
    ...options
  });
}

async function fixture(t, { corruptHash = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-small-backup-"));
  t.after(async () => {
    run("chmod", ["-R", "u+w", root]);
    await fsp.rm(root, { recursive: true, force: true });
  });
  for (const name of ["incoming", "work", "archive", "quarantine", "source"]) {
    await fsp.mkdir(path.join(root, name), { mode: 0o700 });
  }
  const id = "20260729T031500Z-0123456789abcdef01234567";
  const source = path.join(root, "source");
  const database = path.join(source, "database.sqlite");
  const db = new BetterSqlite3(database);
  db.exec("CREATE TABLE smoke_test (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO smoke_test VALUES (1, 'ok')");
  db.close();
  const data = await fsp.readFile(database);
  const manifest = {
    format: "mafusheets-backup", formatVersion: 2, schemaVersion: 6,
    bundleId: id, createdAt: "2026-07-29T03:15:00Z",
    files: [{
      path: "database.sqlite", size: data.length,
      sha256: corruptHash ? "0".repeat(64) : crypto.createHash("sha256").update(data).digest("hex"),
      mode: 0o600, uid: 1000, gid: 1000
    }]
  };
  await fsp.writeFile(path.join(source, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const bundle = path.join(root, "incoming", `${id}.bundle`);
  const packed = run("tar", ["-cf", bundle, "-C", source, "."]);
  assert.equal(packed.status, 0, packed.stderr);
  return { root, id, bundle };
}

function receive(root) {
  return run("python3", [
    RECEIVER, "--incoming", path.join(root, "incoming"),
    "--work", path.join(root, "work"), "--archive", path.join(root, "archive"),
    "--quarantine", path.join(root, "quarantine")
  ]);
}

test("complete bundle is checksum/SQLite verified, archived, and restorable", async (t) => {
  const { root, id } = await fixture(t);
  const received = receive(root);
  assert.equal(received.status, 0, received.stderr);
  assert.match(received.stdout, /"status": "archived"/);
  const archived = path.join(root, "archive", id);
  assert.equal((await fsp.stat(archived)).mode & 0o777, 0o500);
  assert.equal((await fsp.stat(path.join(archived, "database.sqlite"))).mode & 0o777, 0o400);

  const restored = path.join(root, "restored");
  const result = run("python3", [RESTORE, "--source", archived, "--destination", restored]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"ok": true/);
  const db = new BetterSqlite3(path.join(restored, "database.sqlite"), { readonly: true });
  assert.equal(db.prepare("SELECT value FROM smoke_test").pluck().get(), "ok");
  db.close();
});

test("bad SHA-256 is quarantined and never archived", async (t) => {
  const { root, id } = await fixture(t, { corruptHash: true });
  const result = receive(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status": "quarantined"/);
  await assert.rejects(fsp.access(path.join(root, "archive", id)));
  await fsp.access(path.join(root, "quarantine", `${id}.bundle`));
});

test("hidden interrupted rsync temporary file is ignored", async (t) => {
  const { root } = await fixture(t);
  await fsp.rm(path.join(root, "incoming"), { recursive: true });
  await fsp.mkdir(path.join(root, "incoming"));
  await fsp.writeFile(path.join(root, "incoming", ".partial.bundle.ABC123"), "partial");
  const result = receive(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  await fsp.access(path.join(root, "incoming", ".partial.bundle.ABC123"));
});

test("deployment uses packaged forced rrsync and keeps retention disabled by default", async () => {
  const key = await fsp.readFile(path.join(ROOT, "ops/offsite-backup/authorized_keys.example"), "utf8");
  assert.match(key, /^restrict,command="\/usr\/bin\/rrsync -wo -no-del -no-overwrite -munge /);
  const installer = await fsp.readFile(
    path.join(ROOT, "ops/offsite-backup/install-backup-ssh-hardening.sh"), "utf8"
  );
  assert.match(installer, /rrsync -h/);
  assert.match(installer, /sshd -t/);
  const receiver = await fsp.readFile(
    path.join(ROOT, "ops/offsite-backup/mafusheets-backup-receiver.service"), "utf8"
  );
  assert.match(receiver, /^User=root$/m);
  assert.match(receiver, /ReadWritePaths=\/srv\/backups\/mafusheets\/archive/);
  const timer = await fsp.readFile(
    path.join(ROOT, "ops/offsite-backup/mafusheets-backup-retention.timer"), "utf8"
  );
  assert.doesNotMatch(timer, /^WantedBy=.*receiver/m);
  const tools = await fsp.readFile(
    path.join(ROOT, "ops/offsite-backup/install-home-server-tools.sh"), "utf8"
  );
  assert.doesNotMatch(tools, /enable.*retention/);
});

test("receiver rejects traversal tar entries", async (t) => {
  const { root, id } = await fixture(t);
  const script = "import io,tarfile,sys;t=tarfile.open(sys.argv[1],'w');i=tarfile.TarInfo('../escape');i.size=1;t.addfile(i,io.BytesIO(b'x'));t.close()";
  const made = run("python3", ["-c", script, path.join(root, "incoming", `${id}.bundle`)]);
  assert.equal(made.status, 0, made.stderr);
  const result = receive(root);
  assert.match(result.stdout, /"status": "quarantined"/);
  await assert.rejects(fsp.access(path.join(root, "escape")));
});
