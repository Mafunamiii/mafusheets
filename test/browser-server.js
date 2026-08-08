"use strict";

const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  EMERGENCY_ACTOR_ID, createCatalogStore, migrateLegacyCatalog, openDatabase
} = require("../lib/database");
const { createUserStore } = require("../lib/users");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.BROWSER_TEST_PORT || 3218);
const SECRET = "Batch8A-Browser-Test-Secret-Only-2026-xP4mT9vK";

function twoPagePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 37 >>\nstream\nBT /F1 24 Tf 80 200 Td (Page 1) Tj ET\nendstream",
    "<< /Length 37 >>\nstream\nBT /F1 24 Tf 80 200 Td (Page 2) Tj ET\nendstream"
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mafusheets-browser-"));
  const databasePath = path.join(directory, "app.sqlite");
  const catalogPath = path.join(directory, "resources.json");
  const uploads = path.join(directory, "uploads");
  const thumbnails = path.join(directory, "thumbnails");
  await fsp.writeFile(catalogPath, "[]\n");
  await Promise.all([
    fsp.mkdir(path.join(uploads, "photos"), { recursive: true }),
    fsp.mkdir(thumbnails, { recursive: true })
  ]);
  const db = openDatabase(databasePath);
  await migrateLegacyCatalog(db, catalogPath);
  const users = createUserStore(db);
  const admin = await users.createUser({
    loginIdentifier: "admin@example.test", displayName: "Browser Admin",
    password: "AdminPassword2026", role: "admin",
    operator: { actorUserId: EMERGENCY_ACTOR_ID, mode: "emergency-system" }
  });
  const member = await users.createUser({
    loginIdentifier: "member@example.test", displayName: "Browser Member",
    password: "MemberPassword2026", role: "member", operator: { actorUserId: admin.id }
  });
  const other = await users.createUser({
    loginIdentifier: "other@example.test", displayName: "Other Member",
    password: "OtherPassword2026", role: "member", operator: { actorUserId: admin.id }
  });
  await users.createUser({
    loginIdentifier: "forced@example.test", displayName: "Forced Change",
    password: "TemporaryPassword2026", role: "member", mustChangePassword: true,
    operator: { actorUserId: admin.id }
  });
  const timestamp = "2026-07-27T00:00:00.000Z";
  createCatalogStore(db).replaceResources([
    {
      id: "member-sheet", title: "Member sheet", artist: "Member", category: "photos",
      sheetKind: "image", originalName: "member.png", storedName: "member.png",
      extension: ".png", size: 20, uploadedAt: timestamp, uploadedBy: member.id,
      updatedBy: member.id, searchStatus: "ready", searchText: "member", annotations: []
    },
    {
      id: "other-sheet", title: "Other sheet", artist: "Other", category: "photos",
      sheetKind: "image", originalName: "other.png", storedName: "other.png",
      extension: ".png", size: 20, uploadedAt: timestamp, uploadedBy: other.id,
      updatedBy: other.id, searchStatus: "ready", searchText: "other", annotations: []
    },
    {
      id: "pdf-sheet", title: "Two page PDF", artist: "Test", category: "documents",
      sheetKind: "pdf", originalName: "two-pages.pdf", storedName: "two-pages.pdf",
      extension: ".pdf", size: twoPagePdf().length, uploadedAt: timestamp, uploadedBy: admin.id,
      updatedBy: admin.id, searchStatus: "ready", searchText: "first verse hidden refrain",
      searchPages: ["first verse", "hidden refrain"], annotations: []
    }
  ], admin.id);
  db.close();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
    "base64"
  );
  for (const name of ["member.png", "other.png"]) {
    await fsp.writeFile(path.join(uploads, "photos", name), png);
  }
  await fsp.mkdir(path.join(uploads, "documents"), { recursive: true });
  await fsp.writeFile(path.join(uploads, "documents", "two-pages.pdf"), twoPagePdf());
  for (const id of ["member-sheet", "other-sheet"]) {
    await fsp.writeFile(path.join(thumbnails, `${id}.png`), png);
  }

  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOAD_ENV_FILE: "0",
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(PORT),
      DATABASE_PATH: databasePath,
      LEGACY_CATALOG_PATH: catalogPath,
      UPLOADS_DIR: uploads,
      THUMB_DIR: thumbnails,
      TMP_DIR: path.join(directory, "temporary"),
      QUARANTINE_DIR: path.join(directory, "quarantine"),
      SESSION_SECRET: SECRET,
      REQUIRE_HTTPS: "0",
      COOKIE_SECURE: "0",
      PUBLIC_ORIGIN: ""
    },
    stdio: "inherit"
  });
  const stop = async () => {
    child.kill("SIGTERM");
    await fsp.rm(directory, { recursive: true, force: true });
  };
  process.once("SIGTERM", () => { stop().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { stop().finally(() => process.exit(0)); });
  child.once("exit", (code) => {
    fsp.rm(directory, { recursive: true, force: true }).finally(() => process.exit(code || 0));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
