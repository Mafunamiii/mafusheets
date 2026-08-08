"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EMERGENCY_ACTOR_ID, openDatabase } = require("../lib/database");
const { createUserStore } = require("../lib/users");

const ROOT = path.join(__dirname, "..");
const SECRET = "Batch5-Test-Secret-v7Z4mQp2Lx9Ks6Nd3Wc8Hy5Rt";

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP address."));
      const { port } = address;
      socket.close(() => resolve(port));
    });
  });
}

async function startProductionServer(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-batch5-"));
  const databasePath = path.join(directory, "mafusheets.sqlite");
  const db = openDatabase(databasePath);
  await createUserStore(db).createUser({
    loginIdentifier: "secure@example.test",
    displayName: "Secure User",
    password: "SecurePassword2026",
    role: "admin",
    operator: { actorUserId: EMERGENCY_ACTOR_ID, mode: "emergency-system" }
  });
  db.close();
  const port = await unusedPort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOAD_ENV_FILE: "0",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: directory,
      DATABASE_PATH: databasePath,
      LEGACY_CATALOG_PATH: path.join(directory, "missing.json"),
      UPLOADS_DIR: path.join(directory, "uploads"),
      THUMB_DIR: path.join(directory, "thumbnails"),
      TMP_DIR: path.join(directory, "temporary"),
      QUARANTINE_DIR: path.join(directory, "quarantine"),
      SESSION_SECRET: SECRET,
      REQUIRE_HTTPS: "1",
      COOKIE_SECURE: "1",
      PUBLIC_ORIGIN: "https://sheets.example.test",
      TRUST_PROXY: "loopback",
      PDFINFO_BIN: path.join(ROOT, "test/fixtures/pdfinfo"),
      PDFTOPPM_BIN: path.join(ROOT, "test/fixtures/pdftoppm")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await fsp.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(child.exitCode, null, output);
  return { base, directory };
}

test("production HTTPS redirect, exact proxy trust, and secure cookie flags", async (t) => {
  const { base } = await startProductionServer(t);
  const direct = await fetch(`${base}/login`, { redirect: "manual" });
  assert.equal(direct.status, 308);
  assert.equal(direct.headers.get("location"), "https://sheets.example.test/login");

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base.replace("http://", "https://"),
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-proto": "https"
    },
    body: JSON.stringify({
      username: "secure@example.test",
      password: "SecurePassword2026"
    })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /;\s*Secure(?:;|$)/i);
  assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
  assert.match(cookie, /;\s*SameSite=Lax(?:;|$)/i);
  assert.match(cookie, /;\s*Path=\/(?:;|$)/i);
  assert.match(cookie, /;\s*Max-Age=43200(?:;|$)/i);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test("readiness detects unavailable writable storage without touching user content", async (t) => {
  const { base, directory } = await startProductionServer(t);
  const forwarded = { "x-forwarded-proto": "https" };
  const ready = await fetch(`${base}/ready`, { headers: forwarded });
  assert.equal(ready.status, 200);

  const uploads = path.join(directory, "uploads");
  await fsp.chmod(uploads, 0o500);
  try {
    const unavailable = await fetch(`${base}/ready`, { headers: forwarded });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).checks.uploads, false);
    assert.deepEqual(await fsp.readdir(uploads), ["documents", "photos", "slides"]);
  } finally {
    await fsp.chmod(uploads, 0o700);
  }
});

test("production manifests keep Node private and block sensitive proxy paths", async () => {
  const compose = await fsp.readFile(path.join(ROOT, "docker-compose.yml"), "utf8");
  const nginx = await fsp.readFile(path.join(ROOT, "nginx", "nginx.conf"), "utf8");
  assert.match(compose, /mafusheets:[\s\S]*?\n\s+expose:\n\s+- "3000"/);
  assert.doesNotMatch(compose, /mafusheets:[\s\S]*?\n\s+ports:\s*\n\s+- [^\n]*3000/);
  assert.match(compose, /read_only:\s+true/);
  assert.match(compose, /pids_limit:/);
  assert.match(nginx, /return 308 https:\/\/\$host\$request_uri/);
  assert.match(nginx, /client_max_body_size 157286400/);
  assert.match(nginx, /location = \/ready/);
  assert.match(nginx, /sqlite/);
  assert.match(nginx, /source maps|\.map|map/);
});
