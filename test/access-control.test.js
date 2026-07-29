"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EMERGENCY_ACTOR_ID,
  createCatalogStore,
  migrateLegacyCatalog,
  openDatabase
} = require("../lib/database");
const { requireSessionSecret } = require("../lib/security");
const { createUserStore } = require("../lib/users");
const EMERGENCY_OPERATOR = { actorUserId: EMERGENCY_ACTOR_ID, mode: "emergency-system" };

const STRONG_SECRET = "v7Z!4mQp2#Lx9@Ks6^Nd3&Wc8*Hy5$Rt1+Ba";

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

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function login(base, username, password, cookie = "") {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify({ username, password })
  });
  return { response, body: await response.json(), cookie: cookieFrom(response) };
}

/** @param {{method?: string, cookie?: string, csrf?: string, body?: any}} [options] */
async function api(base, route, options = {}) {
  const { method = "GET", cookie = "", csrf = "", body } = options;
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { response, text, body: text ? JSON.parse(text) : null };
}

test("unsafe session secrets are rejected", () => {
  for (const value of ["", "short", "change-me-to-a-long-random-string", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
    assert.throws(() => requireSessionSecret(value), /SESSION_SECRET/);
  }
  assert.equal(requireSessionSecret(STRONG_SECRET), STRONG_SECRET);
});

test("server startup fails when the session secret is empty", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, SESSION_SECRET: "" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /SESSION_SECRET/);
});

test("HTTP access control, session lifecycle, ownership, and audit enforcement", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-access-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "app.sqlite");
  const catalogPath = path.join(directory, "resources.json");
  const uploadsPath = path.join(directory, "uploads");
  const thumbnailsPath = path.join(directory, "thumbnails");
  const temporaryPath = path.join(directory, "tmp");
  await fsp.mkdir(path.join(uploadsPath, "documents"), { recursive: true });
  await fsp.writeFile(path.join(uploadsPath, "documents", "member.pdf"), "member");
  await fsp.writeFile(path.join(uploadsPath, "documents", "other.pdf"), "other");
  await fsp.writeFile(catalogPath, "[]\n");

  const db = openDatabase(databasePath);
  await migrateLegacyCatalog(db, catalogPath);
  const users = createUserStore(db);
  const admin = await users.createUser({
    loginIdentifier: "admin@example.test",
    displayName: "Admin",
    password: "AdminPassword2026",
    role: "admin",
    operator: EMERGENCY_OPERATOR
  });
  const member = await users.createUser({
    loginIdentifier: "member@example.test",
    displayName: "Member",
    password: "MemberPassword2026",
    role: "member",
    operator: { actorUserId: admin.id, mode: "administrator" }
  });
  const other = await users.createUser({
    loginIdentifier: "other@example.test",
    displayName: "Other",
    password: "OtherPassword2026",
    role: "member",
    operator: { actorUserId: admin.id, mode: "administrator" }
  });
  assert.throws(() => users.setEnabled(admin.id, false, { actorUserId: admin.id }),
    /last enabled administrator/);
  assert.throws(() => users.setRole(admin.id, "member", { actorUserId: admin.id }),
    /last enabled administrator/);
  createCatalogStore(db).replaceResources([
    {
      id: "member-resource",
      title: "Member sheet",
      category: "documents",
      sheetKind: "pdf",
      originalName: "member.pdf",
      storedName: "member.pdf",
      extension: ".pdf",
      size: 10,
      uploadedAt: new Date().toISOString(),
      uploadedBy: member.id,
      updatedBy: member.id,
      annotations: []
    },
    {
      id: "other-resource",
      title: "Other sheet",
      category: "documents",
      sheetKind: "pdf",
      originalName: "other.pdf",
      storedName: "other.pdf",
      extension: ".pdf",
      size: 10,
      uploadedAt: new Date().toISOString(),
      uploadedBy: other.id,
      updatedBy: other.id,
      annotations: []
    }
  ], admin.id);
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
      UPLOADS_DIR: uploadsPath,
      THUMB_DIR: thumbnailsPath,
      TMP_DIR: temporaryPath,
      QUARANTINE_DIR: path.join(directory, "quarantine"),
      SESSION_SECRET: STRONG_SECRET,
      REQUIRE_HTTPS: "0",
      COOKIE_SECURE: "0",
      PUBLIC_ORIGIN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += chunk; });
  child.stderr.on("data", (chunk) => { childOutput += chunk; });
  t.after(() => child.kill("SIGTERM"));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(child.exitCode, null, childOutput);

  const guestCatalog = await api(base, "/api/resources");
  assert.equal(guestCatalog.response.status, 200, `${guestCatalog.text}\n${childOutput}`);
  assert.deepEqual(guestCatalog.body.resources, []);
  const guestPage = await (await fetch(`${base}/`)).text();
  assert.match(guestPage, /id="accountButton"/);
  assert.match(guestPage, />Sign in\s*<\/button>/);
  assert.equal(guestPage.includes("Sign in / Register"), false);
  assert.match(guestPage, /id="registerView" hidden/);
  assert.match(guestPage, /\.admin-stack\[hidden\]\s*\{\s*display: none;/);
  assert.match(guestPage, /<h2 id="actionsTitle">Sign in<\/h2>/);
  assert.match(guestPage, /<label>Username\s*<input id="registerLogin"/);
  assert.match(guestPage, /accountButton\.textContent = authState\.authenticated/);
  assert.match(guestPage, /onclick="document\.querySelector\('#actionsDialog'\)\.showModal\(\)"/);
  assert.match(guestPage, /const registerForm = document\.querySelector\("#registerForm"\)/);
  assert.match(guestPage, /accountButton\.addEventListener\("click"/);
  assert.match(guestPage, /async function changeResourceVisibility\(\)/);
  assert.match(guestPage, /loginForm\.addEventListener\('submit'/);
  assert.match(guestPage, /registerForm\.addEventListener\("submit", registerAccount\)/);
  assert.equal((await login(base, "member@example.test", "WrongPassword2026")).response.status, 401);

  const firstMemberLogin = await login(base, "member@example.test", "MemberPassword2026", "mafusheets_admin=fixed");
  assert.equal(firstMemberLogin.response.status, 200, JSON.stringify(firstMemberLogin.body));
  assert.notEqual(firstMemberLogin.cookie, "mafusheets_admin=fixed");
  const secondMemberLogin = await login(base, "member@example.test", "MemberPassword2026", firstMemberLogin.cookie);
  assert.notEqual(secondMemberLogin.cookie, firstMemberLogin.cookie);

  const memberAuth = {
    cookie: secondMemberLogin.cookie,
    csrf: secondMemberLogin.body.csrfToken
  };
  assert.equal((await api(base, "/api/account/profile", {
    method: "PATCH", ...memberAuth,
    body: { displayName: "Updated Member", currentPassword: "WrongPassword2026" }
  })).response.status, 400);
  const profileUpdate = await api(base, "/api/account/profile", {
    method: "PATCH", ...memberAuth,
    body: { displayName: "Updated Member", currentPassword: "MemberPassword2026" }
  });
  assert.equal(profileUpdate.response.status, 200);
  assert.equal(profileUpdate.body.user.displayName, "Updated Member");
  const mine = await api(base, "/api/resources?mine=1", memberAuth);
  assert.deepEqual(mine.body.resources.map((resource) => resource.id), ["member-resource"]);
  assert.equal(mine.body.resources[0].uploadedByDisplayName, "Updated Member");
  assert.equal((await api(base, "/api/admin/thumbnails/refresh", {
    method: "POST", ...memberAuth
  })).response.status, 403);
  assert.equal((await api(base, "/api/admin/users", memberAuth)).response.status, 403);
  assert.equal((await api(base, "/api/resources/other-resource", {
    method: "PATCH", ...memberAuth, body: { title: "Stolen edit" }
  })).response.status, 403);
  assert.equal((await api(base, "/api/resources/member-resource", {
    method: "PATCH", ...memberAuth, body: { title: "Owned edit" }
  })).response.status, 200);
  assert.equal((await api(base, "/api/resources/member-resource", {
    method: "DELETE", ...memberAuth
  })).response.status, 403);

  const annotation = await api(base, "/api/resources/member-resource/annotations", {
    method: "POST", ...memberAuth, body: { page: 1, text: "Mine" }
  });
  assert.equal(annotation.response.status, 201);

  const otherLogin = await login(base, "other@example.test", "OtherPassword2026");
  assert.equal((await api(
    base,
    `/api/resources/member-resource/annotations/${annotation.body.annotation.id}`,
    { method: "DELETE", cookie: otherLogin.cookie, csrf: otherLogin.body.csrfToken }
  )).response.status, 403);

  const adminLogin = await login(base, "admin@example.test", "AdminPassword2026");
  const adminReaderPage = await (await fetch(`${base}/sheets/member-resource`, {
    headers: { Cookie: adminLogin.cookie }
  })).text();
  assert.match(adminReaderPage, /id="visibilityButton"/);
  assert.match(adminReaderPage, /visibilityButton\.addEventListener\("click", changeResourceVisibility\)/);
  const memberReaderPage = await (await fetch(`${base}/sheets/member-resource`, {
    headers: { Cookie: memberAuth.cookie }
  })).text();
  assert.doesNotMatch(memberReaderPage, /id="visibilityButton"/);
  const publish = await api(base, "/api/admin/resources/member-resource/visibility", {
    method: "PATCH",
    cookie: adminLogin.cookie,
    csrf: adminLogin.body.csrfToken,
    body: { visibility: "guest" }
  });
  assert.equal(publish.response.status, 200);
  assert.deepEqual(
    (await api(base, "/api/resources")).body.resources.map((resource) => resource.id),
    ["member-resource"]
  );
  assert.equal((await fetch(`${base}/files/member-resource`)).status, 200);
  assert.equal((await fetch(`${base}/files/other-resource`)).status, 404);
  assert.equal((await api(base, `/api/admin/users/${admin.id}`, {
    method: "PATCH",
    cookie: adminLogin.cookie,
    csrf: adminLogin.body.csrfToken,
    body: { enabled: false }
  })).response.status, 400);
  const sorted = await api(base, "/api/resources?sort=title-desc", {
    cookie: adminLogin.cookie
  });
  assert.deepEqual(sorted.body.resources.map((resource) => resource.title), [
    "Owned edit", "Other sheet"
  ]);
  assert.equal((await api(base, "/api/admin/users", {
    cookie: adminLogin.cookie
  })).body.users.length, 3);
  assert.equal((await api(base, "/api/admin/users", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      loginIdentifier: "created@example.test",
      displayName: "Created User",
      password: "CreatedPassword2026",
      role: "member"
    }
  })).response.status, 403);
  const createdAccount = await api(base, "/api/admin/users", {
    method: "POST",
    cookie: adminLogin.cookie,
    csrf: adminLogin.body.csrfToken,
    body: {
      loginIdentifier: "created@example.test",
      displayName: "Created User",
      password: "CreatedPassword2026",
      role: "member",
      mustChangePassword: true
    }
  });
  assert.equal(createdAccount.response.status, 201, createdAccount.text);
  assert.equal(createdAccount.body.user.mustChangePassword, true);
  const createdId = createdAccount.body.user.id;
  const promotedAccount = await api(base, `/api/admin/users/${createdId}`, {
    method: "PATCH",
    cookie: adminLogin.cookie,
    csrf: adminLogin.body.csrfToken,
    body: { role: "admin" }
  });
  assert.equal(promotedAccount.body.user.role, "admin");
  const renamedAccount = await api(base, `/api/admin/users/${createdId}`, {
    method: "PATCH",
    cookie: adminLogin.cookie,
    csrf: adminLogin.body.csrfToken,
    body: {
      loginIdentifier: "renamed-created@example.test",
      displayName: "Renamed Created User"
    }
  });
  assert.equal(renamedAccount.body.user.loginIdentifier, "renamed-created@example.test");
  const resetAccount = await api(base, `/api/admin/users/${createdId}/reset-password`, {
    method: "POST",
    cookie: adminLogin.cookie,
    csrf: adminLogin.body.csrfToken,
    body: { password: "ReplacementPassword2026", mustChangePassword: true }
  });
  assert.equal(resetAccount.response.status, 200, resetAccount.text);
  assert.equal((await login(
    base, "renamed-created@example.test", "ReplacementPassword2026"
  )).response.status, 200);
  assert.equal((await api(base, "/api/resources/other-resource", {
    method: "PATCH",
    cookie: adminLogin.cookie,
    csrf: adminLogin.body.csrfToken,
    body: { title: "Admin edit" }
  })).response.status, 200);
  const adminDelete = await api(base, "/api/resources/other-resource", {
    method: "DELETE",
    cookie: adminLogin.cookie,
    csrf: adminLogin.body.csrfToken
  });
  assert.equal(adminDelete.response.status, 200, `${adminDelete.text}\n${childOutput}`);

  const loginPage = await (await fetch(`${base}/login`)).text();
  const mainPage = await (await fetch(`${base}/`, {
    headers: { cookie: adminLogin.cookie }
  })).text();
  for (const forbidden of [STRONG_SECRET, "SESSION_SECRET", "DELETE_CODE", "deleteCode"]) {
    assert.equal(loginPage.includes(forbidden), false);
    assert.equal(mainPage.includes(forbidden), false);
  }

  const liveDb = openDatabase(databasePath);
  createUserStore(liveDb).setEnabled(member.id, false, { actorUserId: admin.id });
  assert.deepEqual(
    (await api(base, "/api/resources", memberAuth)).body.resources.map((resource) => resource.id),
    ["member-resource"]
  );
  liveDb.close();

  const logout = await api(base, "/api/auth/logout", {
    method: "POST",
    cookie: adminLogin.cookie,
    csrf: adminLogin.body.csrfToken
  });
  assert.equal(logout.response.status, 200);
  assert.equal((await api(base, "/api/resources", { cookie: adminLogin.cookie })).response.status, 200);

  const auditDb = openDatabase(databasePath);
  const eventTypes = new Set(
    auditDb.prepare("SELECT event_type FROM audit_events").all().map((row) => row.event_type)
  );
  for (const expected of [
    "login_succeeded",
    "login_rejected",
    "logout",
    "authorization_rejected",
    "resource_modification_requested"
  ]) {
    assert.equal(eventTypes.has(expected), true, `missing ${expected}`);
  }
  auditDb.close();
});
