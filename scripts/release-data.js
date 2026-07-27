"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { openDatabase, CURRENT_SCHEMA_VERSION } = require("../lib/database");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}

function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required.`);
  return path.resolve(value);
}

function safeDestination(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || resolved === process.cwd() || resolved.length < parsed.root.length + 8) {
    throw new Error(`Refusing dangerous path: ${resolved}`);
  }
  return resolved;
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function regularFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    const child = path.join(root, childRelative);
    const stat = await fsp.lstat(child);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${child}`);
    if (stat.isDirectory()) files.push(...await regularFiles(root, childRelative));
    else if (stat.isFile()) files.push({ relative: childRelative, stat });
    else throw new Error(`Refusing non-regular backup source: ${child}`);
  }
  return files;
}

async function copyRegularTree(source, destination) {
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const item of await regularFiles(source)) {
    const target = path.join(destination, item.relative);
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fsp.copyFile(path.join(source, item.relative), target, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(target, item.stat.mode & 0o777);
  }
}

async function inventory(root, prefix) {
  const result = [];
  for (const item of await regularFiles(root)) {
    const filePath = path.join(root, item.relative);
    result.push({
      path: path.posix.join(prefix, item.relative.split(path.sep).join("/")),
      sha256: await hashFile(filePath),
      size: item.stat.size,
      mode: item.stat.mode & 0o777,
      uid: item.stat.uid,
      gid: item.stat.gid
    });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function backup() {
  if (!process.argv.includes("--quiesced")) {
    throw new Error("Backup requires --quiesced after application writes have been stopped.");
  }
  const databasePath = required("--database");
  const uploadsPath = required("--uploads");
  const output = safeDestination(required("--output"));
  if (!argument("--release") || !argument("--image") || !argument("--config-id")) {
    throw new Error("--release, --image, and --config-id are required non-secret identifiers.");
  }
  await fsp.access(databasePath, fs.constants.R_OK);
  const uploadsStat = await fsp.lstat(uploadsPath);
  if (!uploadsStat.isDirectory() || uploadsStat.isSymbolicLink()) {
    throw new Error("Uploads source must be a real directory.");
  }
  await fsp.mkdir(output, { mode: 0o700 });
  const snapshot = path.join(output, "database.sqlite");
  const db = openDatabase(databasePath);
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`Source SQLite integrity check failed: ${integrity}`);
    await db.backup(snapshot);
  } finally {
    db.close();
  }
  await fsp.chmod(snapshot, 0o600);
  await copyRegularTree(uploadsPath, path.join(output, "uploads"));
  const files = [
    ...(await inventory(output, "")).filter((item) => item.path !== "manifest.json")
  ];
  const manifest = {
    format: "mafusheets-paired-backup-v1",
    createdAt: new Date().toISOString(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    release: argument("--release"),
    image: argument("--image"),
    configId: argument("--config-id"),
    consistency: "application-writes-quiesced",
    files
  };
  await fsp.writeFile(
    path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o600 }
  );
  const result = { ok: true, action: "backup", output, files: files.length, manifest };
  console.error(`Backup complete: ${files.length} files in ${output}`);
  console.log(JSON.stringify(result));
}

async function loadVerifiedManifest(source) {
  const sourceStat = await fsp.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Backup source must be a real directory.");
  }
  const manifest = JSON.parse(await fsp.readFile(path.join(source, "manifest.json"), "utf8"));
  if (manifest.format !== "mafusheets-paired-backup-v1" || !Array.isArray(manifest.files)) {
    throw new Error("Unsupported backup manifest.");
  }
  for (const item of manifest.files) {
    if (
      !item || typeof item.path !== "string" || path.isAbsolute(item.path) ||
      item.path.split("/").includes("..")
    ) throw new Error("Unsafe manifest path.");
    const filePath = path.join(source, ...item.path.split("/"));
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe backup item: ${item.path}`);
    if (stat.size !== item.size || await hashFile(filePath) !== item.sha256) {
      throw new Error(`Checksum verification failed: ${item.path}`);
    }
  }
  return manifest;
}

async function assertEmptyDestination(databasePath, uploadsPath) {
  if (fs.existsSync(databasePath)) {
    throw new Error("Restore database destination already exists.");
  }
  if (fs.existsSync(uploadsPath)) {
    const stat = await fsp.lstat(uploadsPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fsp.readdir(uploadsPath)).length) {
      throw new Error("Restore uploads destination must be an empty real directory.");
    }
  }
}

async function restore() {
  const source = safeDestination(required("--source"));
  const databasePath = safeDestination(required("--database"));
  const uploadsPath = safeDestination(required("--uploads"));
  await assertEmptyDestination(databasePath, uploadsPath);
  const manifest = await loadVerifiedManifest(source);
  const snapshot = path.join(source, "database.sqlite");
  await fsp.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  await fsp.copyFile(snapshot, databasePath, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(databasePath, 0o600);
  await copyRegularTree(path.join(source, "uploads"), uploadsPath);
  const db = openDatabase(databasePath);
  let missing;
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`Restored SQLite integrity check failed: ${integrity}`);
    const rows = db.prepare(`
      SELECT r.id, f.category, f.stored_name FROM resources r
      JOIN resource_files f ON f.resource_id=r.id AND f.ordinal=0
      WHERE r.deleted_at IS NULL
    `).all();
    missing = rows.filter((row) =>
      !fs.existsSync(path.join(uploadsPath, row.category, row.stored_name))
    ).map((row) => row.id);
    if (missing.length) throw new Error(`Restored resources missing source files: ${missing.join(", ")}`);
  } finally {
    db.close();
  }
  const result = {
    ok: true, action: "restore", database: databasePath, uploads: uploadsPath,
    schemaVersion: manifest.schemaVersion, release: manifest.release,
    image: manifest.image, configId: manifest.configId, missingResourceFiles: missing
  };
  console.error(`Restore complete: ${databasePath} and ${uploadsPath}`);
  console.log(JSON.stringify(result));
}

async function rollback() {
  const previous = JSON.parse(await fsp.readFile(required("--previous"), "utf8"));
  const current = JSON.parse(await fsp.readFile(required("--current"), "utf8"));
  const output = safeDestination(required("--output"));
  for (const value of [previous, current]) {
    if (!value.release || !value.image || !value.configId) {
      throw new Error("Release metadata requires release, image, and configId.");
    }
  }
  const plan = {
    format: "mafusheets-rollback-plan-v1",
    createdAt: new Date().toISOString(),
    failedRelease: current,
    restoreRelease: previous,
    operatorAction: `Deploy image ${previous.image} with config ${previous.configId}`
  };
  await fsp.writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.error(`Rollback plan created for ${previous.release}: ${output}`);
  console.log(JSON.stringify({ ok: true, action: "rollback", output, plan }));
}

async function main() {
  const command = process.argv[2];
  if (command === "backup") return backup();
  if (command === "restore") return restore();
  if (command === "rollback") return rollback();
  throw new Error("Usage: release-data.js backup|restore|rollback [options]");
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 2;
});
