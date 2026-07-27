"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
  UploadPolicyError,
  normalizeFilename,
  validateDeclaredMime,
  validateSignature
} = require("../lib/upload-policy");
const { createProcessingJobStore } = require("../lib/processing-jobs");
const {
  MIGRATION_ACTOR_ID,
  migrateLegacyCatalog,
  openDatabase
} = require("../lib/database");
const { createUserStore } = require("../lib/users");

const SECRET = "Batch4!Strong&Persistent#Session$Secret2026";

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function multipartUpload(base, auth, files, kind = "chart") {
  const body = new FormData();
  body.append("title", "Batch 4");
  body.append("kind", kind);
  for (const file of files) {
    body.append("files", new Blob([file.bytes], { type: file.type }), file.name);
  }
  const response = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
    body
  });
  return { response, body: await response.json() };
}

async function temporaryFile(t, bytes) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-batch4-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "upload");
  await fsp.writeFile(filePath, bytes);
  return filePath;
}

test("filenames are normalized and traversal, null bytes, and extension confusion are rejected", () => {
  assert.deepEqual(normalizeFilename("Ｓｃｏｒｅ.PDF"), {
    originalName: "Score.PDF",
    extension: ".pdf"
  });
  for (const name of ["../score.pdf", "/tmp/score.pdf", "folder\\score.pdf", "bad\0.pdf", "run.exe.pdf"]) {
    assert.throws(() => normalizeFilename(name), UploadPolicyError);
  }
});

test("declared MIME must match the extension", () => {
  assert.doesNotThrow(() => validateDeclaredMime(".pdf", "application/pdf"));
  assert.throws(
    () => validateDeclaredMime(".pdf", "image/png"),
    (error) => error.code === "MIME_MISMATCH"
  );
});

test("actual signatures reject forged PDFs and forged images", async (t) => {
  const forgedPdf = await temporaryFile(t, Buffer.from("not a pdf"));
  await assert.rejects(
    validateSignature(forgedPdf, ".pdf", { maxImagePixels: 40_000_000 }),
    (error) => error.code === "BAD_SIGNATURE"
  );
  const forgedPng = await temporaryFile(t, Buffer.from("%PDF-1.4\n%%EOF"));
  await assert.rejects(
    validateSignature(forgedPng, ".png", { maxImagePixels: 40_000_000 }),
    (error) => error.code === "BAD_SIGNATURE"
  );
});

test("extreme PNG dimensions are rejected before image decoding", async (t) => {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(100_000, 16);
  header.writeUInt32BE(100_000, 20);
  const filePath = await temporaryFile(t, header);
  await assert.rejects(
    validateSignature(filePath, ".png", { maxImagePixels: 40_000_000 }),
    (error) => error.code === "IMAGE_DIMENSIONS"
  );
});

test("processing jobs persist attribution and stop retrying at their cap", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-jobs-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const catalog = path.join(directory, "resources.json");
  await fsp.writeFile(catalog, "[]\n");
  const db = openDatabase(path.join(directory, "app.sqlite"));
  t.after(() => db.close());
  await migrateLegacyCatalog(db, catalog);
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO resources
      (id, title, sheet_kind, search_status, uploaded_by, updated_by, created_at, updated_at)
    VALUES ('resource', 'Resource', 'pdf', 'pending', ?, ?, ?, ?)
  `).run(MIGRATION_ACTOR_ID, MIGRATION_ACTOR_ID, timestamp, timestamp);
  const jobs = createProcessingJobStore(db);
  const id = jobs.enqueue("resource", MIGRATION_ACTOR_ID, 2);
  let job = jobs.next();
  assert.equal(job.actor_user_id, MIGRATION_ACTOR_ID);
  jobs.fail(id, new Error("/private/path parser crashed"));
  job = jobs.next();
  assert.equal(job.attempts, 2);
  jobs.fail(id, new Error("again"));
  assert.equal(db.prepare("SELECT status, attempts FROM processing_jobs WHERE id=?").get(id).status, "failed");
  assert.equal(jobs.next(), null);
});

test("HTTP uploads reject size, count, quota, forgery, traversal, partial batches, and concurrency abuse", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-http-batch4-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "app.sqlite");
  const catalogPath = path.join(directory, "resources.json");
  await fsp.writeFile(catalogPath, "[]\n");
  const db = openDatabase(databasePath);
  await migrateLegacyCatalog(db, catalogPath);
  await createUserStore(db).createUser({
    loginIdentifier: "uploader@example.test",
    displayName: "Uploader",
    password: "UploaderPassword2026",
    role: "member"
  });
  db.close();

  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: databasePath,
      LEGACY_CATALOG_PATH: catalogPath,
      UPLOADS_DIR: path.join(directory, "uploads"),
      TMP_DIR: path.join(directory, "tmp"),
      THUMB_DIR: path.join(directory, "thumbs"),
      QUARANTINE_DIR: path.join(directory, "quarantine"),
      SESSION_SECRET: SECRET,
      UPLOAD_MAX_FILE_BYTES: "1024",
      UPLOAD_MAX_REQUEST_BYTES: "2500",
      UPLOAD_MAX_FILES: "3",
      UPLOAD_USER_STORAGE_BYTES: "1024",
      UPLOAD_USER_DAILY_BYTES: "disabled",
      UPLOAD_USER_CONCURRENCY: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(() => child.kill("SIGTERM"));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(child.exitCode, null, output);
  const loginResponse = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "uploader@example.test", password: "UploaderPassword2026" })
  });
  const loginBody = await loginResponse.json();
  const auth = { cookie: cookieFrom(loginResponse), csrf: loginBody.csrfToken };

  assert.equal((await multipartUpload(base, auth, [{
    name: "large.txt", type: "text/plain", bytes: Buffer.alloc(1100, 65)
  }])).response.status, 413);
  assert.equal((await multipartUpload(base, auth, Array.from({ length: 3 }, (_, index) => ({
    name: `batch-${index}.txt`, type: "text/plain", bytes: Buffer.alloc(900, 65)
  })))).response.status, 413);
  assert.equal((await multipartUpload(base, auth, Array.from({ length: 4 }, (_, index) => ({
    name: `file-${index}.txt`, type: "text/plain", bytes: "x"
  })))).response.status, 400);
  assert.equal((await multipartUpload(base, auth, [{
    name: "fake.pdf", type: "application/pdf", bytes: "not pdf"
  }], "pdf")).response.status, 400);
  assert.equal((await multipartUpload(base, auth, [{
    name: "wrong.pdf", type: "image/png", bytes: "%PDF-1.4\n%%EOF"
  }], "pdf")).response.status, 400);
  assert.equal((await multipartUpload(base, auth, [{
    name: "../escape.txt", type: "text/plain", bytes: "safe"
  }])).response.status, 400);

  const partial = await multipartUpload(base, auth, [
    { name: "valid.txt", type: "text/plain", bytes: "valid" },
    { name: "invalid.txt", type: "text/plain", bytes: Buffer.from([0, 1, 2]) }
  ]);
  assert.equal(partial.response.status, 400);

  const concurrent = await Promise.all([
    multipartUpload(base, auth, [{ name: "one.txt", type: "text/plain", bytes: Buffer.alloc(600, 65) }]),
    multipartUpload(base, auth, [{ name: "two.txt", type: "text/plain", bytes: Buffer.alloc(600, 66) }])
  ]);
  assert.equal(concurrent.some((result) => result.response.status === 429), true);
  assert.equal(concurrent.some((result) => result.response.status === 201), true);

  const quota = await multipartUpload(base, auth, [{
    name: "quota.txt", type: "text/plain", bytes: Buffer.alloc(600, 67)
  }]);
  assert.equal(quota.response.status, 413);

  const live = openDatabase(databasePath);
  assert.equal(live.prepare("SELECT COUNT(*) count FROM resources").get().count, 1);
  live.close();
});
