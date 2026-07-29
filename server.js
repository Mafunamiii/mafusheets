const express = require("express");
const { rateLimit } = require("express-rate-limit");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const JSZip = require("jszip");
const { normalizeSearchText } = require("./search-indexer");
const { createCatalogStore, migrateLegacyCatalog, openDatabase } = require("./lib/database");
const { createUserStore } = require("./lib/users");
const { createResourceStore } = require("./lib/resources");
const { createProcessingJobStore } = require("./lib/processing-jobs");
const { runWorkerProcess } = require("./lib/isolated-worker");
const {
  UploadPolicyError,
  normalizeFilename,
  validateDeclaredMime,
  validateSignature
} = require("./lib/upload-policy");
const {
  SESSION_TTL_MS,
  auditEvent,
  createSessionStore,
  digest,
  requireSessionSecret
} = require("./lib/security");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (!key) {
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, ".env"));
process.umask(0o077);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DATABASE_FILE = process.env.DATABASE_PATH || path.join(ROOT, "data", "mafusheets.sqlite");
const DATA_DIR = process.env.DATA_DIR ||
  (process.env.DATABASE_PATH ? path.dirname(DATABASE_FILE) : path.join(ROOT, "data"));
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(ROOT, "uploads");
const TMP_DIR = process.env.TMP_DIR || path.join(ROOT, ".tmp");
const STAGING_DIR = path.join(TMP_DIR, "staging");
const TRASH_DIR = process.env.QUARANTINE_DIR || path.join(DATA_DIR, "quarantine");
const THUMB_DIR = process.env.THUMB_DIR || path.join(DATA_DIR, "thumbnails");
const INDEX_FILE = process.env.LEGACY_CATALOG_PATH || path.join(DATA_DIR, "resources.json");
const PDFTOPPM_BIN = process.env.PDFTOPPM_BIN || (process.platform === "win32" ? "pdftoppm.cmd" : "pdftoppm");
const PDFINFO_BIN = process.env.PDFINFO_BIN || (process.platform === "win32" ? "pdfinfo.exe" : "pdfinfo");
const REQUIRE_HTTPS = process.env.REQUIRE_HTTPS === "1";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const PUBLIC_ORIGIN = String(process.env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
const TRUST_PROXY = String(process.env.TRUST_PROXY || "").trim();
let parsedPublicOrigin = null;
try {
  parsedPublicOrigin = PUBLIC_ORIGIN ? new URL(PUBLIC_ORIGIN) : null;
} catch {}

if (REQUIRE_HTTPS && !COOKIE_SECURE) {
  throw new Error("COOKIE_SECURE=1 is required when REQUIRE_HTTPS=1.");
}
if (
  REQUIRE_HTTPS &&
  (!parsedPublicOrigin || parsedPublicOrigin.protocol !== "https:" ||
   parsedPublicOrigin.origin !== PUBLIC_ORIGIN)
) {
  throw new Error("PUBLIC_ORIGIN must be an https:// origin without a path when REQUIRE_HTTPS=1.");
}

function boundedInteger(
  name, defaultValue,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, allowDisabled = false } = {}
) {
  const raw = process.env[name];
  if (allowDisabled && raw === "disabled") return null;
  const value = raw === undefined || raw === "" ? defaultValue : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}${allowDisabled ? ', or "disabled"' : ""}.`);
  }
  return value;
}

const MAX_FILE_SIZE = boundedInteger("UPLOAD_MAX_FILE_BYTES", 50 * 1024 * 1024, {
  min: 1024, max: 250 * 1024 * 1024
});
const MAX_REQUEST_SIZE = boundedInteger("UPLOAD_MAX_REQUEST_BYTES", 150 * 1024 * 1024, {
  min: MAX_FILE_SIZE, max: 500 * 1024 * 1024
});
const MAX_FILES_PER_UPLOAD = boundedInteger("UPLOAD_MAX_FILES", 10, { min: 1, max: 20 });
const USER_STORAGE_QUOTA = boundedInteger("UPLOAD_USER_STORAGE_BYTES", 2 * 1024 * 1024 * 1024, {
  min: MAX_FILE_SIZE, max: 100 * 1024 * 1024 * 1024
});
const USER_DAILY_UPLOAD_QUOTA = boundedInteger(
  "UPLOAD_USER_DAILY_BYTES", 500 * 1024 * 1024,
  { min: MAX_FILE_SIZE, max: 10 * 1024 * 1024 * 1024, allowDisabled: true }
);
const PROCESSING_CONCURRENCY = boundedInteger("UPLOAD_WORKER_CONCURRENCY", 2, { min: 1, max: 4 });
const USER_UPLOAD_CONCURRENCY = boundedInteger("UPLOAD_USER_CONCURRENCY", 1, { min: 1, max: 3 });
const PROCESS_TIMEOUT_MS = boundedInteger("UPLOAD_PROCESS_TIMEOUT_MS", 30000, { min: 1000, max: 120000 });
const REQUEST_TIMEOUT_MS = boundedInteger("UPLOAD_REQUEST_TIMEOUT_MS", 120000, {
  min: 10000, max: 10 * 60 * 1000
});
const MAX_PDF_PAGES = boundedInteger("UPLOAD_MAX_PDF_PAGES", 500, { min: 1, max: 2000 });
const MAX_IMAGE_PIXELS = boundedInteger("UPLOAD_MAX_IMAGE_PIXELS", 40_000_000, {
  min: 1_000_000, max: 100_000_000
});
const STAGING_MAX_AGE_MS = boundedInteger("UPLOAD_STAGING_MAX_AGE_MS", 24 * 60 * 60 * 1000, {
  min: 60 * 60 * 1000, max: 7 * 24 * 60 * 60 * 1000
});
const SESSION_COOKIE = "mafusheets_admin";
const SESSION_SECRET = requireSessionSecret(process.env.SESSION_SECRET);
let database;
let catalogStore;
let userStore;
let sessionStore;
let resourceStore;
let processingJobStore;
let startupIntegrityReport = null;
let processingActive = 0;
let processingScheduled = false;
let shuttingDown = false;
const activeUploads = new Map();
const activeStagingPaths = new Set();
const validationWaiters = [];
let validationActive = 0;
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    const login = String(req.body && req.body.username || "").trim().toLowerCase();
    return `${digest(SESSION_SECRET, req.ip || "").slice(0, 16)}:${digest(SESSION_SECRET, login).slice(0, 16)}`;
  },
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    if (database) {
      auditEvent(database, {
        eventType: "login_rejected",
        entityType: "session",
        details: auditDetails(req, { reason: "rate_limited" })
      });
    }
    res.status(429).json({ error: "Too many login attempts. Please wait and try again." });
  }
});

const uploadKinds = {
  pdf: {
    label: "PDF sheets",
    extensions: new Set([".pdf"]),
    storageCategory: "documents"
  },
  image: {
    label: "Images",
    extensions: new Set([".png", ".jpg", ".jpeg"]),
    storageCategory: "photos"
  },
  chart: {
    label: "Chord charts",
    extensions: new Set([".txt", ".md", ".docx"]),
    storageCategory: "documents"
  }
};

const mimeTypes = {
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

const upload = multer({
  dest: STAGING_DIR,
  preservePath: true,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES_PER_UPLOAD,
    fields: 12,
    parts: MAX_FILES_PER_UPLOAD + 12,
    fieldNameSize: 80,
    fieldSize: 16 * 1024
  }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many uploads. Please wait a bit and try again." }
});

if (TRUST_PROXY) {
  app.set("trust proxy", TRUST_PROXY);
}
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
const allowPublic = (_req, _res, next) => next();
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; frame-ancestors 'self'; object-src 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'"
  );
  if (req.path.startsWith("/api/") || req.path === "/" || req.path === "/login" ||
      req.path.startsWith("/files/") || req.path.startsWith("/sheets/")) {
    res.setHeader("Cache-Control", "private, no-store");
  }
  next();
});
app.use((req, res, next) => {
  if (!REQUIRE_HTTPS || req.secure || req.path === "/health" || req.path === "/ready") {
    return next();
  }
  return res.redirect(308, `${PUBLIC_ORIGIN}${req.originalUrl}`);
});

app.get("/assets/logo.png", allowPublic, (_req, res) => {
  res.type("png").sendFile(path.join(ROOT, "logo.png"));
});

app.get("/favicon.ico", allowPublic, (_req, res) => {
  res.type("png").sendFile(path.join(ROOT, "logo.png"));
});

app.get("/assets/banner.png", allowPublic, (_req, res) => {
  res.type("png").sendFile(path.join(ROOT, "Banner.png"));
});

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.mkdir(STAGING_DIR, { recursive: true });
  await fsp.chmod(TMP_DIR, 0o700);
  await fsp.chmod(STAGING_DIR, 0o700);
  await fsp.mkdir(TRASH_DIR, { recursive: true });
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  await Promise.all(
    ["documents", "photos", "slides"].map((category) =>
      fsp.mkdir(path.join(UPLOADS_DIR, category), { recursive: true })
    )
  );
  await fsp.chmod(UPLOADS_DIR, 0o700);
  await Promise.all(["documents", "photos", "slides"].map((category) =>
    fsp.chmod(path.join(UPLOADS_DIR, category), 0o700)
  ));

  database = openDatabase(DATABASE_FILE);
  await migrateLegacyCatalog(database, INDEX_FILE);
  catalogStore = createCatalogStore(database);
  resourceStore = createResourceStore(database);
  processingJobStore = createProcessingJobStore(database);
  processingJobStore.recoverInterrupted();
  processingJobStore.enqueueMissing();
  userStore = createUserStore(database);
  sessionStore = createSessionStore(database, SESSION_SECRET);
  sessionStore.purgeExpired();
  startupIntegrityReport = await resourceStore.reportIntegrity({
    uploadsDir: UPLOADS_DIR,
    stagingDir: STAGING_DIR,
    trashDir: TRASH_DIR
  });
  if (!startupIntegrityReport.ok) {
    console.error(`Startup integrity check found ${startupIntegrityReport.issues.length} issue(s). Run "npm run integrity".`);
  }
  await cleanupStaleStaging();
  scheduleProcessing();
}

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  const cookies = {};

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) {
      continue;
    }

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = "";
    }
  }

  return cookies;
}

function createCookieValue(token) {
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(token).digest("hex");
  return `${token}.${signature}`;
}

function verifyCookieValue(value) {
  if (!value) {
    return null;
  }

  const parts = String(value).split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [token, signature] = parts;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(token).digest("hex");
  if (signature.length !== expected.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  return token;
}

function getSession(req) {
  const token = verifyCookieValue(parseCookies(req)[SESSION_COOKIE]);
  return sessionStore && token ? sessionStore.validate(token) : null;
}

function setSessionCookie(res, token) {
  const value = createCookieValue(token);
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + Math.floor(SESSION_TTL_MS / 1000)
  ];

  if (COOKIE_SECURE) {
    attrs.push("Secure");
  }

  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res) {
  const attrs = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (COOKIE_SECURE) {
    attrs.push("Secure");
  }

  res.setHeader("Set-Cookie", attrs.join("; "));
}

function isSameOrigin(req) {
  const origin = req.get("origin");
  if (!origin) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    const host = req.get("host");
    const proto = req.secure ? "https:" : "http:";
    return parsed.protocol === proto && parsed.host === host;
  } catch {
    return false;
  }
}

function requireAuthenticated(req, res, next) {
  const session = getSession(req);
  if (!session) {
    auditRejected(req, "authentication_required");
    if (req.accepts("html")) {
      return res.status(401).type("html").send(renderLoginHtml());
    }

    return res.status(401).json({ error: "Login required." });
  }

  req.auth = session;
  req.adminSession = session;
  if (
    session.mustChangePassword &&
    req.path !== "/api/auth/me" &&
    req.path !== "/api/auth/logout" &&
    req.path !== "/api/auth/change-password"
  ) {
    auditRejected(req, "password_change_required");
    return res.status(403).json({ error: "Password change required." });
  }
  return next();
}

function requireApproved(req, res, next) {
  return requireAuthenticated(req, res, () => {
    if (req.adminSession.role !== "admin" && !req.adminSession.approved) {
      auditRejected(req, "account_approval_required");
      return res.status(403).json({ error: "Administrator approval is required." });
    }
    return next();
  });
}

function requireAdmin(req, res, next) {
  return requireAuthenticated(req, res, () => {
    if (req.adminSession.role !== "admin") {
      auditRejected(req, "administrator_required");
      return res.status(403).json({ error: "Administrator access required." });
    }
    return next();
  });
}

function requireSameOrigin(req, res, next) {
  if (!isSameOrigin(req)) {
    if (database) auditRejected(req, "same_origin_required");
    return res.status(403).json({ error: "Cross-origin requests are not allowed." });
  }

  return next();
}

function requireCsrf(req, res, next) {
  const session = req.adminSession || getSession(req);
  const token = String(req.get("x-csrf-token") || "");

  if (!session || !sessionStore.verifyCsrf(session, token)) {
    if (database) auditRejected(req, "csrf_validation_failed");
    return res.status(403).json({ error: "Invalid security token." });
  }

  req.adminSession = session;
  return next();
}

function issueSession(user) {
  return {
    ...sessionStore.issue(user.id),
    user: user.loginIdentifier,
    displayName: user.displayName,
    userId: user.id,
    role: user.role
    ,approved: user.approved
  };
}

function revokeSession(token) {
  sessionStore.revoke(token);
}

function auditDetails(req, details = {}) {
  const forwarded = String(req.ip || req.socket.remoteAddress || "");
  return {
    ...details,
    clientFingerprint: forwarded ? digest(SESSION_SECRET, forwarded).slice(0, 16) : undefined
  };
}

function recordAudit(req, eventType, entityType, entityId, details = {}) {
  auditEvent(database, {
    actorUserId: req.adminSession ? req.adminSession.userId : null,
    eventType,
    entityType,
    entityId,
    details: auditDetails(req, details)
  });
}

function auditRejected(req, reason, entityType = "route", entityId = null) {
  recordAudit(req, "authorization_rejected", entityType, entityId, {
    reason,
    method: req.method,
    path: req.route ? req.route.path : req.path
  });
}

function safeLogError(context, error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  const name = error && typeof error.name === "string" ? error.name : "Error";
  const raw = String(error && error.message || "operation failed");
  const redacted = raw
    .replaceAll(ROOT, "[app]")
    .replaceAll(DATA_DIR, "[data]")
    .replaceAll(UPLOADS_DIR, "[uploads]")
    .replaceAll(TMP_DIR, "[tmp]")
    .replace(/(session|cookie|authorization|token|secret|password)=?\S*/gi, "$1=[redacted]")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 300);
  console.error(`${context}: ${name}${code ? ` ${code}` : ""}: ${redacted}`);
}

async function requireResourceEditor(req, res, next) {
  const resources = await readIndex();
  const resource = getResourceById(resources, req.params.id);
  if (!resource) return res.status(404).json({ error: "Sheet not found." });
  if (req.adminSession.role !== "admin" && resource.uploadedBy !== req.adminSession.userId) {
    auditRejected(req, "resource_owner_required", "resource", resource.id);
    return res.status(403).json({ error: "You cannot modify this resource." });
  }
  req.authorizedResource = resource;
  return next();
}

async function requireAnnotationOwner(req, res, next) {
  const resources = await readIndex();
  const resource = getResourceById(resources, req.params.id);
  const annotation = resource && (resource.annotations || [])
    .find((item) => item.id === req.params.annotationId);
  if (!resource || !annotation) return res.status(404).json({ error: "Annotation not found." });
  if (req.adminSession.role !== "admin" && annotation.userId !== req.adminSession.userId) {
    auditRejected(req, "annotation_owner_required", "annotation", annotation.id);
    return res.status(403).json({ error: "You cannot modify this annotation." });
  }
  return next();
}

async function readIndex() {
  if (!catalogStore) throw new Error("Catalog database is not initialized.");
  return catalogStore.listResources();
}

function canViewResource(resource, session) {
  return resource && (
    resource.visibility === "guest" ||
    Boolean(session && (session.role === "admin" || session.approved))
  );
}

async function visibleResource(req, id) {
  const resource = getResourceById(await readIndex(), id);
  return canViewResource(resource, req.adminSession || getSession(req)) ? resource : null;
}

function cleanText(value, limit = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function escapeHtmlText(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function cleanNotes(value, limit = 2500) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, limit);
}

function cleanNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

function parseTags(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const tags = [];
  const seen = new Set();

  for (const part of raw.split(",")) {
    const tag = cleanText(part, 40);
    if (!tag) {
      continue;
    }

    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    tags.push(tag);
  }

  return tags.slice(0, 24);
}

function normalizeKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return uploadKinds[kind] ? kind : "";
}

function sheetKindForExtension(extension) {
  if (extension === ".pdf") {
    return "pdf";
  }

  if ([".png", ".jpg", ".jpeg"].includes(extension)) {
    return "image";
  }

  if ([".txt", ".md", ".docx"].includes(extension)) {
    return "chart";
  }

  return "other";
}

function getStorageCategory(kind, extension) {
  if (kind && uploadKinds[kind]) {
    return uploadKinds[kind].storageCategory;
  }

  if ([".png", ".jpg", ".jpeg"].includes(extension)) {
    return "photos";
  }

  return "documents";
}

function isAllowedForKind(kind, extension) {
  return Boolean(uploadKinds[kind] && uploadKinds[kind].extensions.has(extension));
}

function canPreview(resource) {
  return [".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md"].includes(resource.extension);
}

function thumbnailUrl(resource, sheetKind) {
  if (sheetKind === "pdf" || sheetKind === "image") {
    return `/thumbnails/${encodeURIComponent(resource.id)}.png`;
  }

  return "";
}

function annotationsCount(resource) {
  return Array.isArray(resource.annotations) ? resource.annotations.length : 0;
}

function publicResource(resource) {
  const safeResource = { ...resource };
  delete safeResource.searchText;
  delete safeResource.storedName;
  delete safeResource.annotations;
  const sheetKind = resource.sheetKind || sheetKindForExtension(resource.extension);
  return {
    ...safeResource,
    sheetKind,
    tags: Array.isArray(resource.tags) ? resource.tags : [],
    annotationsCount: annotationsCount(resource),
    canPreview: canPreview(resource),
    readerUrl: sheetKind === "pdf" ? `/sheets/${encodeURIComponent(resource.id)}` : "",
    thumbnailUrl: thumbnailUrl(resource, sheetKind),
    viewUrl: `/files/${encodeURIComponent(resource.id)}`,
    downloadUrl: `/files/${encodeURIComponent(resource.id)}?download=1`
  };
}

function fullResource(resource) {
  return {
    ...publicResource(resource),
    annotations: Array.isArray(resource.annotations) ? resource.annotations : []
  };
}

function guestResource(resource) {
  const safe = publicResource(resource);
  delete safe.uploadedBy;
  delete safe.updatedBy;
  delete safe.notes;
  return safe;
}

function resourceMatchesQuery(resource, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return true;
  }

  const annotations = Array.isArray(resource.annotations) ? resource.annotations : [];
  return [
    resource.title,
    resource.artist,
    resource.key,
    resource.capo,
    resource.bpm,
    resource.notes,
    resource.originalName,
    resource.category,
    resource.extension,
    Array.isArray(resource.tags) ? resource.tags.join(" ") : "",
    annotations.map((annotation) => annotation.text).join(" "),
    resource.searchText
  ]
    .filter(Boolean)
    .some((value) => normalizeSearchText(value).includes(normalizedQuery));
}

function getResourceById(resources, id) {
  return resources.find((item) => item.id === id) || null;
}

function resolveResourceFile(resource) {
  const filePath = path.join(UPLOADS_DIR, resource.category, resource.storedName);
  const resolved = path.resolve(filePath);
  const categoryDir = path.resolve(path.join(UPLOADS_DIR, resource.category));

  const relative = path.relative(categoryDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    return null;
  }

  return resolved;
}

async function removeTempFiles(files) {
  await Promise.all(
    (files || []).map(async (file) => {
      activeStagingPaths.delete(file.path);
      await fsp.unlink(file.path).catch(() => undefined);
    })
  );
}

async function cleanupStaleStaging({ now = Date.now() } = {}) {
  let removed = 0;
  const entries = await fsp.readdir(STAGING_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(STAGING_DIR, entry.name);
    if (activeStagingPaths.has(filePath)) continue;
    const stat = await fsp.lstat(filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue;
    if (now - stat.mtimeMs < STAGING_MAX_AGE_MS) continue;
    await fsp.unlink(filePath).then(() => { removed += 1; }).catch(() => undefined);
  }
  return removed;
}

function acquireValidationSlot() {
  if (validationActive < PROCESSING_CONCURRENCY) {
    validationActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => validationWaiters.push(resolve));
}

function releaseValidationSlot() {
  const next = validationWaiters.shift();
  if (next) next();
  else validationActive -= 1;
}

function workerLimits() {
  return {
    childOutputBytes: 64 * 1024,
    maxArchiveEntries: 2000,
    maxArchiveExpandedBytes: Math.min(MAX_REQUEST_SIZE, 100 * 1024 * 1024),
    maxImagePixels: MAX_IMAGE_PIXELS,
    maxPdfPages: MAX_PDF_PAGES,
    pdfInfoBin: PDFINFO_BIN,
    pdfToPpmBin: PDFTOPPM_BIN,
    processTimeoutMs: PROCESS_TIMEOUT_MS
  };
}

async function runIsolated(message, timeoutMs = PROCESS_TIMEOUT_MS) {
  await acquireValidationSlot();
  try {
    return await runWorkerProcess({
      workerPath: path.join(ROOT, "processing-worker.js"),
      cwd: TMP_DIR,
      message,
      limits: workerLimits(),
      timeoutMs,
      envPath: process.env.PATH || ""
    });
  } finally {
    releaseValidationSlot();
  }
}

async function validateUploadedFiles(files, kind) {
  let total = 0;
  for (const file of files) {
    activeStagingPaths.add(file.path);
    const normalized = normalizeFilename(file.originalname);
    file.safeOriginalName = normalized.originalName;
    file.safeExtension = normalized.extension;
    if (!isAllowedForKind(kind, normalized.extension)) {
      throw new UploadPolicyError(`The file "${normalized.originalName}" is not allowed for this sheet type.`);
    }
    validateDeclaredMime(normalized.extension, file.mimetype);
    if (file.size > MAX_FILE_SIZE) throw new UploadPolicyError("A file exceeds the configured size limit.", 413);
    total += file.size;
    if (total > MAX_REQUEST_SIZE) {
      throw new UploadPolicyError("The combined upload exceeds the configured request limit.", 413, "BATCH_SIZE");
    }
  }
  for (const file of files) {
    await validateSignature(file.path, file.safeExtension, { maxImagePixels: MAX_IMAGE_PIXELS });
    await runIsolated({
      action: "validate",
      filePath: file.path,
      extension: file.safeExtension
    });
  }
  return total;
}

function userUsage(userId) {
  const stored = database.prepare(`
    SELECT COALESCE(SUM(f.size), 0) bytes
    FROM resources r JOIN resource_files f ON f.resource_id=r.id
    WHERE r.uploaded_by=? AND r.deleted_at IS NULL
  `).get(userId).bytes;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const daily = database.prepare(`
    SELECT COALESCE(SUM(bytes), 0) bytes FROM upload_usage
    WHERE user_id=? AND occurred_at>=?
  `).get(userId, since).bytes;
  return { stored, daily };
}

function enforceUserQuota(actorUserId, incomingBytes, { storageUserId = actorUserId, replacedBytes = 0 } = {}) {
  const storageUsage = userUsage(storageUserId);
  const actorUsage = storageUserId === actorUserId ? storageUsage : userUsage(actorUserId);
  if (storageUsage.stored - replacedBytes + incomingBytes > USER_STORAGE_QUOTA) {
    throw new UploadPolicyError("Your storage quota would be exceeded.", 413, "STORAGE_QUOTA");
  }
  if (USER_DAILY_UPLOAD_QUOTA !== null && actorUsage.daily + incomingBytes > USER_DAILY_UPLOAD_QUOTA) {
    throw new UploadPolicyError("Your daily upload allowance would be exceeded.", 429, "DAILY_QUOTA");
  }
}

function enforceRequestLength(req, res, next) {
  const raw = req.get("content-length");
  if (raw) {
    const length = Number(raw);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_REQUEST_SIZE) {
      return res.status(413).json({ error: "The upload request exceeds the configured size limit." });
    }
  }
  return next();
}

function limitConcurrentUserUploads(req, res, next) {
  const userId = req.adminSession.userId;
  const count = activeUploads.get(userId) || 0;
  if (count >= USER_UPLOAD_CONCURRENCY) {
    return res.status(429).json({ error: "Another upload for this account is already in progress." });
  }
  activeUploads.set(userId, count + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = activeUploads.get(userId) || 1;
    if (current <= 1) activeUploads.delete(userId);
    else activeUploads.set(userId, current - 1);
  };
  res.once("finish", release);
  res.once("close", release);
  next();
}

async function executeProcessingJob(job) {
  const resource = getResourceById(await readIndex(), job.resource_id);
  if (!resource) throw new Error("Resource no longer exists.");
  const lockOwner = crypto.randomUUID();
  const release = resourceStore.acquireLock(
    `resource:${resource.id}`, lockOwner, PROCESS_TIMEOUT_MS + 30000
  );
  const temporaryThumbnail = path.join(THUMB_DIR, `.${resource.id}-${crypto.randomUUID()}`);
  try {
    const filePath = resolveResourceFile(resource);
    if (!filePath) throw new Error("Resource path is invalid.");
    const thumbnailPath = path.join(THUMB_DIR, `${resource.id}.png`);
    const result = await runIsolated({
      action: "process",
      extension: resource.extension,
      filePath,
      thumbnailPath: temporaryThumbnail
    }, PROCESS_TIMEOUT_MS);
    const committed = resourceStore.updateSearchIndex(
      resource.id, resource.updatedAt,
      { searchText: result.searchText, searchStatus: result.searchStatus },
      job.actor_user_id
    );
    if (!committed) {
      const conflict = Object.assign(
        new Error("Resource changed while processing; retrying current version."),
        { code: "PROCESSING_VERSION_CONFLICT" }
      );
      throw conflict;
    }
    if (result.generatedThumbnail) {
      await fsp.rename(result.generatedThumbnail, thumbnailPath);
      resourceStore.finishPendingThumbnails(resource.id);
    }
  } catch (error) {
    error.processingResourceId = resource.id;
    error.processingExpectedUpdatedAt = resource.updatedAt;
    throw error;
  } finally {
    await Promise.all([
      fsp.unlink(`${temporaryThumbnail}.worker.png`).catch(() => undefined),
      fsp.unlink(`${temporaryThumbnail}.worker.png.png`).catch(() => undefined)
    ]);
    release();
  }
}

function scheduleProcessing() {
  if (!processingJobStore || processingScheduled || shuttingDown) return;
  processingScheduled = true;
  setImmediate(async () => {
    processingScheduled = false;
    while (processingActive < PROCESSING_CONCURRENCY && !shuttingDown) {
      const job = processingJobStore.next();
      if (!job) break;
      processingActive += 1;
      executeProcessingJob(job)
        .then(() => processingJobStore.succeed(job.id))
        .catch((error) => {
          const outcome = processingJobStore.fail(job.id, error);
          if (
            outcome === "failed" && error.processingResourceId &&
            error.processingExpectedUpdatedAt
          ) {
            resourceStore.markProcessingFailed(
              error.processingResourceId,
              error.processingExpectedUpdatedAt,
              job.actor_user_id,
              error.code === "PROCESSING_VERSION_CONFLICT"
                ? "version conflict retry limit reached" : "processing retry limit reached"
            );
          }
        })
        .finally(() => {
          processingActive -= 1;
          scheduleProcessing();
        });
    }
  });
}

function enqueueProcessing(resource, actorUserId) {
  processingJobStore.enqueue(resource.id, actorUserId, 2);
  scheduleProcessing();
}

app.get("/", allowPublic, (req, res) => {
  const session = getSession(req);
  res.type("html").send(renderMainHtml({
    authenticated: Boolean(session),
    csrfToken: session?.csrfToken || "",
    username: session?.user || "",
    displayName: session?.displayName || "",
    userId: session?.userId || "",
    role: session?.role || "",
    approved: Boolean(session?.approved),
    mustChangePassword: Boolean(session?.mustChangePassword)
  }));
});

app.get("/login", allowPublic, (req, res) => {
  const session = getSession(req);
  if (session) {
    return res.redirect("/");
  }

  return res.type("html").send(renderLoginHtml());
});

app.get("/health", allowPublic, (_req, res) => {
  res.json({ ok: true, status: "live" });
});

function executablePath(command) {
  if (path.isAbsolute(command)) return command;
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function probeWritable(directory) {
  const probe = path.join(directory, `.health-${process.pid}-${crypto.randomUUID()}`);
  const handle = await fsp.open(probe, "wx", 0o600);
  try {
    await handle.writeFile("");
    await handle.sync();
  } finally {
    await handle.close();
    await fsp.unlink(probe).catch(() => undefined);
  }
}

app.get("/ready", allowPublic, async (_req, res) => {
  const checks = {};
  try {
    checks.sqlite = database && database.prepare("SELECT 1 AS ok").get().ok === 1;
  } catch {
    checks.sqlite = false;
  }
  const writable = {
    database: path.dirname(DATABASE_FILE),
    uploads: UPLOADS_DIR,
    thumbnails: THUMB_DIR,
    staging: STAGING_DIR,
    quarantine: TRASH_DIR
  };
  for (const [name, directory] of Object.entries(writable)) {
    try {
      await probeWritable(directory);
      checks[name] = true;
    } catch {
      checks[name] = false;
    }
  }
  checks.pdfinfo = Boolean(executablePath(PDFINFO_BIN));
  checks.pdftoppm = Boolean(executablePath(PDFTOPPM_BIN));
  checks.worker = fs.existsSync(path.join(ROOT, "processing-worker.js"));
  checks.integrity = Boolean(startupIntegrityReport && startupIntegrityReport.ok);
  const ok = Object.values(checks).every(Boolean);
  res.status(ok ? 200 : 503).json({ ok, status: ok ? "ready" : "unready", checks });
});

app.get("/api/auth/me", requireAuthenticated, (req, res) => {
  const session = req.adminSession;
  res.json({
    authenticated: true,
    user: session.user,
    displayName: session.displayName,
    userId: session.userId,
    role: session.role,
    approved: session.approved,
    mustChangePassword: session.mustChangePassword,
    csrfToken: session.csrfToken
  });
});

app.post("/api/auth/login", allowPublic, authLimiter, requireSameOrigin, async (req, res) => {
  const username = cleanText(req.body.username, 128);
  const password = String(req.body.password || "");
  const user = await userStore.authenticate(username, password);
  if (!user) {
    auditEvent(database, {
      eventType: "login_rejected",
      entityType: "session",
      details: auditDetails(req, { loginFingerprint: digest(SESSION_SECRET, username.toLowerCase()).slice(0, 16) })
    });
    return res.status(401).json({ error: "Invalid credentials." });
  }

  revokeSession(verifyCookieValue(parseCookies(req)[SESSION_COOKIE]));
  const session = issueSession(user);
  auditEvent(database, {
    actorUserId: user.id,
    eventType: "login_succeeded",
    entityType: "session",
    details: auditDetails(req)
  });
  setSessionCookie(res, session.token);
  res.json({
    ok: true,
    user: session.user,
    displayName: session.displayName,
    userId: session.userId,
    role: session.role,
    approved: session.approved,
    mustChangePassword: user.mustChangePassword,
    csrfToken: session.csrfToken
  });
});

app.post("/api/auth/register", allowPublic, authLimiter, requireSameOrigin, async (req, res) => {
  try {
    const user = await userStore.register({
      loginIdentifier: req.body && req.body.loginIdentifier,
      displayName: req.body && req.body.displayName,
      password: req.body && req.body.password
    });
    const session = issueSession(user);
    setSessionCookie(res, session.token);
    res.status(201).json({
      ok: true,
      user: session.user,
      displayName: session.displayName,
      userId: session.userId,
      role: session.role,
      approved: session.approved,
      csrfToken: session.csrfToken
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/auth/logout", requireAuthenticated, requireSameOrigin, requireCsrf, (req, res) => {
  recordAudit(req, "logout", "session", null);
  revokeSession(req.adminSession.token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.patch("/api/account/profile", requireAuthenticated, requireSameOrigin, requireCsrf, async (req, res) => {
  try {
    const user = await userStore.updateOwnProfile(
      req.adminSession.userId,
      req.body && req.body.displayName,
      req.body && req.body.currentPassword
    );
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/auth/change-password", requireAuthenticated, requireSameOrigin, requireCsrf, async (req, res) => {
  try {
    const user = await userStore.changePassword(
      req.adminSession.userId,
      String(req.body.currentPassword || ""),
      String(req.body.newPassword || "")
    );
    const session = issueSession(user);
    setSessionCookie(res, session.token);
    res.json({ ok: true, csrfToken: session.csrfToken });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/resources", async (req, res) => {
  req.adminSession = getSession(req);
  const activeKind = String(req.query.kind || "all").trim().toLowerCase();
  const query = String(req.query.q || "");
  const sort = String(req.query.sort || "newest").trim().toLowerCase();
  const mineOnly = String(req.query.mine || "") === "1";
  const allResources = await readIndex();
  const resources = allResources.filter((resource) =>
    canViewResource(resource, req.adminSession)
  );
  const filtered = resources.filter((resource) => {
    const kind = resource.sheetKind || sheetKindForExtension(resource.extension);
    const inKind = activeKind === "all" || kind === activeKind;
    return inKind && (!mineOnly || resource.uploadedBy === req.adminSession?.userId) &&
      resourceMatchesQuery(resource, query);
  });

  const titleOrder = (a, b) => String(a.title || "").localeCompare(
    String(b.title || ""), undefined, { numeric: true, sensitivity: "base" }
  );
  const dateOrder = (a, b) =>
    new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
  if (sort === "title-asc") filtered.sort(titleOrder);
  else if (sort === "title-desc") filtered.sort((a, b) => titleOrder(b, a));
  else if (sort === "oldest") filtered.sort((a, b) => dateOrder(b, a));
  else filtered.sort(dateOrder);

  res.json({
    total: resources.length,
    count: filtered.length,
    resources: filtered.map((resource) => ({
      ...(req.adminSession && (req.adminSession.role === "admin" || req.adminSession.approved)
        ? publicResource(resource) : guestResource(resource)),
      ...(req.adminSession && (req.adminSession.role === "admin" || req.adminSession.approved)
        ? { uploadedByDisplayName:
            userStore.getUserById(resource.uploadedBy)?.displayName || "Unknown user" }
        : {})
    }))
  });
});

app.get("/api/resources/:id", async (req, res) => {
  req.adminSession = getSession(req);
  const resource = await visibleResource(req, req.params.id);

  if (!resource) {
    return res.status(404).json({ error: "Sheet not found." });
  }

  const mayUseMemberFeatures = Boolean(
    req.adminSession && (req.adminSession.role === "admin" || req.adminSession.approved)
  );
  res.json({ resource: mayUseMemberFeatures ? {
    ...fullResource(resource),
    uploadedByDisplayName: userStore.getUserById(resource.uploadedBy)?.displayName || "Unknown user"
  } : guestResource(resource) });
});

app.patch("/api/resources/:id", requireApproved, requireSameOrigin, requireCsrf, requireResourceEditor, async (req, res) => {
  recordAudit(req, "resource_modification_requested", "resource", req.params.id, { operation: "edit" });
  const updates = {
    title: cleanText(req.body.title, 120),
    artist: cleanText(req.body.artist, 120),
    key: cleanText(req.body.key, 24),
    notes: cleanNotes(req.body.notes, 2500),
    tags: parseTags(req.body.tags)
  };
  const capo = cleanNumber(req.body.capo, { min: 0, max: 24 });
  const bpm = cleanNumber(req.body.bpm, { min: 20, max: 400 });

  if (!updates.title) return res.status(400).json({ error: "A title is required." });
  try {
    const result = resourceStore.updateMetadata(req.params.id, { ...updates, capo, bpm }, req.adminSession.userId);
    if (!result) return res.status(404).json({ error: "Sheet not found." });
    const resource = getResourceById(await readIndex(), req.params.id);
    return res.json({ resource: fullResource(resource) });
  } catch (error) {
    resourceStore.recordFailure({
      operationType: "cleanup", actorId: req.adminSession.userId,
      resourceId: req.params.id, error, details: { operation: "metadata_update" }
    });
    safeLogError("resource update failed", error);
    return res.status(500).json({ error: "Update failed." });
  }
});

app.post(
  "/api/resources/:id/file",
  requireApproved,
  requireSameOrigin,
  requireCsrf,
  requireResourceEditor,
  limitConcurrentUserUploads,
  enforceRequestLength,
  upload.single("file"),
  async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Choose a replacement file." });
    const current = req.authorizedResource;
    const kind = normalizeKind(req.body.kind) || current.sheetKind;
    let extension;
    const id = crypto.randomUUID();
    const originalPath = resolveResourceFile(current);
    try {
      const total = await validateUploadedFiles([file], kind);
      enforceUserQuota(req.adminSession.userId, total, {
        storageUserId: current.uploadedBy,
        replacedBytes: current.size
      });
      extension = file.safeExtension;
      const category = getStorageCategory(kind, extension);
      const storedName = `${Date.now()}-${id}${extension}`;
      const finalPath = path.join(UPLOADS_DIR, category, storedName);
      const backupPath = path.join(TRASH_DIR, `replacement-${id}-${path.basename(current.storedName)}`);
      const result = resourceStore.replaceFile(req.params.id, {
        stagedPath: file.path,
        finalPath,
        originalPath,
        backupPath,
        category,
        originalName: file.safeOriginalName,
        storedName,
        extension,
        size: file.size,
        sheetKind: sheetKindForExtension(extension),
        searchText: "",
        searchStatus: "pending"
      }, req.adminSession.userId);
      if (!result) {
        await removeTempFiles([file]);
        return res.status(404).json({ error: "Sheet not found." });
      }
      activeStagingPaths.delete(file.path);
      await fsp.unlink(path.join(THUMB_DIR, `${current.id}.png`)).catch(() => undefined);
      const updated = getResourceById(await readIndex(), req.params.id);
      enqueueProcessing(updated, req.adminSession.userId);
      return res.json({ resource: fullResource(updated) });
    } catch (error) {
      await removeTempFiles([file]);
      safeLogError("resource replacement failed", error);
      if (error instanceof UploadPolicyError) {
        return res.status(error.status).json({ error: error.message });
      }
      return res.status(500).json({ error: "Replacement failed; the original file was retained." });
    }
  }
);

app.delete("/api/resources/:id", requireAdmin, requireSameOrigin, requireCsrf, async (req, res) => {
  recordAudit(req, "resource_modification_requested", "resource", req.params.id, { operation: "delete" });

  const resource = getResourceById(await readIndex(), req.params.id);
  if (!resource) return res.status(404).json({ error: "Sheet not found." });
  const source = resolveResourceFile(resource);
  const suffix = crypto.randomUUID();
  const artifacts = [
    {
      source,
      quarantine: path.join(TRASH_DIR, `${suffix}-${resource.storedName}`),
      required: true
    },
    {
      source: path.join(THUMB_DIR, `${resource.id}.png`),
      quarantine: path.join(TRASH_DIR, `${suffix}-${resource.id}.png`),
      required: false
    }
  ];
  try {
    const pending = resourceStore.deleteResource(req.params.id, req.adminSession.userId, artifacts);
    if (!pending) return res.status(404).json({ error: "Sheet not found." });
    resourceStore.finalizeDeletion(pending.operationId, req.adminSession.userId);
    return res.json({ ok: true });
  } catch (error) {
    safeLogError("resource deletion failed", error);
    return res.status(500).json({
      error: "Deletion is incomplete. An administrator must run the integrity report and retry cleanup."
    });
  }
});

app.post("/api/resources/:id/annotations", requireApproved, requireSameOrigin, requireCsrf, async (req, res) => {
  recordAudit(req, "resource_modification_requested", "resource", req.params.id, { operation: "annotation_create" });
  const page = cleanNumber(req.body.page, { min: 1, max: 9999 });
  const text = cleanText(req.body.text, 500);
  const color = cleanText(req.body.color, 24) || "amber";

  if (!page || !text) {
    return res.status(400).json({ error: "A page number and annotation text are required." });
  }

  try {
    const annotation = resourceStore.createAnnotation(req.params.id, {
      id: crypto.randomUUID(), page, text, color
    }, req.adminSession.userId);
    if (!annotation) return res.status(404).json({ error: "Sheet not found." });
    return res.status(201).json({ annotation });
  } catch (error) {
    safeLogError("annotation creation failed", error);
    return res.status(500).json({ error: "Could not save annotation." });
  }
});

app.delete("/api/resources/:id/annotations/:annotationId", requireApproved, requireSameOrigin, requireCsrf, requireAnnotationOwner, async (req, res) => {
  recordAudit(req, "resource_modification_requested", "annotation", req.params.annotationId, { operation: "annotation_delete" });
  try {
    const result = resourceStore.deleteAnnotation(
      req.params.id, req.params.annotationId, req.adminSession.userId,
      req.adminSession.role === "admin"
    );
    if (result.status === "missing") return res.status(404).json({ error: "Annotation not found." });
    if (result.status === "forbidden") return res.status(403).json({ error: "You cannot modify this annotation." });
    return res.json({ ok: true });
  } catch (error) {
    safeLogError("annotation deletion failed", error);
    return res.status(500).json({ error: "Could not delete annotation." });
  }
});

app.post(
  "/api/upload",
  uploadLimiter,
  requireApproved,
  requireSameOrigin,
  requireCsrf,
  limitConcurrentUserUploads,
  enforceRequestLength,
  upload.array("files", MAX_FILES_PER_UPLOAD),
  async (req, res) => {
  recordAudit(req, "resource_modification_requested", "resource", null, { operation: "upload" });
  const kind = normalizeKind(req.body.kind);
  const title = cleanText(req.body.title);
  const artist = cleanText(req.body.artist, 120);
  const key = cleanText(req.body.key, 24);
  const notes = cleanNotes(req.body.notes, 2500);
  const tags = parseTags(req.body.tags);
  const capo = cleanNumber(req.body.capo, { min: 0, max: 24 });
  const bpm = cleanNumber(req.body.bpm, { min: 20, max: 400 });
  const files = req.files || [];

  if (!kind) {
    await removeTempFiles(files);
    return res.status(400).json({ error: "Choose a valid sheet type." });
  }

  if (!title) {
    await removeTempFiles(files);
    return res.status(400).json({ error: "A title is required." });
  }

  if (!files.length) {
    return res.status(400).json({ error: "Choose at least one file." });
  }

  const uploadedAt = new Date().toISOString();
  const created = [];
  const moves = [];

  try {
    const totalBytes = await validateUploadedFiles(files, kind);
    enforceUserQuota(req.adminSession.userId, totalBytes);
    for (const file of files) {
      const extension = file.safeExtension;
      const id = crypto.randomUUID();
      const storedName = `${Date.now()}-${id}${extension}`;
      const storageCategory = getStorageCategory(kind, extension);
      const destination = path.join(UPLOADS_DIR, storageCategory, storedName);

      const resource = {
        id,
        title: files.length === 1 ? title : `${title} - ${file.safeOriginalName}`,
        artist,
        key,
        capo,
        bpm,
        notes,
        tags,
        category: storageCategory,
        sheetKind: sheetKindForExtension(extension),
        originalName: file.safeOriginalName,
        storedName,
        extension,
        size: file.size,
        uploadedAt,
        uploadedBy: req.adminSession.userId,
        updatedBy: req.adminSession.userId,
        searchText: "",
        searchStatus: "pending",
        indexedAt: null,
        annotations: []
      };

      created.push(resource);
      moves.push({ stagedPath: file.path, finalPath: destination });
    }

    resourceStore.createBatch(created, moves, req.adminSession.userId);
    for (const file of files) activeStagingPaths.delete(file.path);
    for (const resource of created) {
      enqueueProcessing(resource, req.adminSession.userId);
    }

    res.status(201).json({ resources: created.map(publicResource) });
  } catch (error) {
    await removeTempFiles(files);
    safeLogError("upload failed", error);
    if (error instanceof UploadPolicyError) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: "Upload failed. Please try again." });
  }
});

app.post("/api/admin/thumbnails/refresh", requireAdmin, requireSameOrigin, requireCsrf, async (req, res) => {
  recordAudit(req, "maintenance_requested", "catalog", null, { operation: "thumbnail_refresh" });
  try {
    const resources = await readIndex();
    let refreshed = 0;

    for (const resource of resources) {
      if (![".pdf", ".png", ".jpg", ".jpeg"].includes(resource.extension)) {
        continue;
      }

      enqueueProcessing(resource, req.adminSession.userId);
      refreshed += 1;
    }

    res.json({ ok: true, refreshed });
  } catch (error) {
    safeLogError("thumbnail refresh failed", error);
    res.status(500).json({ error: "Could not refresh thumbnails." });
  }
});

app.get("/api/admin/users", requireAdmin, (_req, res) => {
  res.json({ users: userStore.listUsers() });
});

app.post("/api/admin/users", requireAdmin, requireSameOrigin, requireCsrf, async (req, res) => {
  try {
    const user = await userStore.createUser({
      loginIdentifier: req.body && req.body.loginIdentifier,
      displayName: req.body && req.body.displayName,
      password: req.body && req.body.password,
      role: req.body && req.body.role || "member",
      mustChangePassword: req.body && req.body.mustChangePassword !== false,
      operator: { actorUserId: req.adminSession.userId, mode: "administrator" }
    });
    res.status(201).json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch("/api/admin/users/:id", requireAdmin, requireSameOrigin, requireCsrf, (req, res) => {
  try {
    const operator = { actorUserId: req.adminSession.userId, mode: "administrator" };
    let user = userStore.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    if (
      req.params.id === req.adminSession.userId && req.body &&
      (Object.hasOwn(req.body, "role") || Object.hasOwn(req.body, "enabled"))
    ) {
      return res.status(400).json({ error: "You cannot change your own role or enabled status." });
    }
    if (
      req.body &&
      (Object.hasOwn(req.body, "loginIdentifier") || Object.hasOwn(req.body, "displayName"))
    ) {
      user = userStore.updateIdentity(req.params.id, {
        loginIdentifier: req.body.loginIdentifier,
        displayName: req.body.displayName
      }, operator);
    }
    if (req.body && Object.hasOwn(req.body, "role")) {
      user = userStore.setRole(req.params.id, req.body.role, operator);
    }
    if (req.body && Object.hasOwn(req.body, "enabled")) {
      user = userStore.setEnabled(req.params.id, Boolean(req.body.enabled), operator);
    }
    if (req.body && Object.hasOwn(req.body, "approved")) {
      user = userStore.setApproved(req.params.id, Boolean(req.body.approved), operator);
    }
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch(
  "/api/admin/resources/:id/visibility",
  requireAdmin,
  requireSameOrigin,
  requireCsrf,
  (req, res) => {
    const visibility = String(req.body && req.body.visibility || "");
    if (!["guest", "restricted"].includes(visibility)) {
      return res.status(400).json({ error: "Visibility must be guest or restricted." });
    }
    const current = database.prepare(
      "SELECT visibility FROM resources WHERE id=? AND deleted_at IS NULL"
    ).get(req.params.id);
    if (!current) return res.status(404).json({ error: "Sheet not found." });
    const timestamp = new Date().toISOString();
    database.transaction(() => {
      database.prepare(`
        UPDATE resources SET visibility=?, updated_by=?, updated_at=? WHERE id=?
      `).run(visibility, req.adminSession.userId, timestamp, req.params.id);
      auditEvent(database, {
        actorUserId: req.adminSession.userId,
        eventType: "resource_visibility_changed",
        entityType: "resource",
        entityId: req.params.id,
        details: { from: current.visibility, to: visibility }
      });
    })();
    res.json({ ok: true, visibility });
  }
);

app.post(
  "/api/admin/users/:id/reset-password",
  requireAdmin,
  requireSameOrigin,
  requireCsrf,
  async (req, res) => {
    try {
      const user = await userStore.resetPassword(req.params.id, req.body && req.body.password, {
        mustChangePassword: req.body && req.body.mustChangePassword !== false,
        operator: { actorUserId: req.adminSession.userId, mode: "administrator" }
      });
      res.json({ user });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

app.post("/api/admin/staging/cleanup", requireAdmin, requireSameOrigin, requireCsrf, async (req, res) => {
  recordAudit(req, "maintenance_requested", "catalog", null, { operation: "staging_cleanup" });
  const removed = await cleanupStaleStaging();
  res.json({ ok: true, removed });
});

app.get("/api/admin/processing", requireAdmin, async (_req, res) => {
  res.json({ jobs: processingJobStore.counts(), active: processingActive });
});

app.get("/api/admin/integrity", requireAdmin, async (req, res) => {
  recordAudit(req, "maintenance_requested", "catalog", null, { operation: "integrity_report" });
  const report = await resourceStore.reportIntegrity({
    uploadsDir: UPLOADS_DIR,
    stagingDir: STAGING_DIR,
    trashDir: TRASH_DIR
  });
  res.status(report.ok ? 200 : 409).json(report);
});

app.get("/sheets/:id", async (req, res) => {
  req.adminSession = getSession(req);
  const resource = await visibleResource(req, req.params.id);
  const session = getSession(req);

  if (!resource) {
    return res.status(404).type("html").send(renderMainHtml({
      authenticated: Boolean(session),
      csrfToken: session ? session.csrfToken : "",
      username: session ? session.user : "",
      userId: session ? session.userId : "",
      role: session ? session.role : "",
      mustChangePassword: session ? session.mustChangePassword : false
    }));
  }

  if ((resource.sheetKind || sheetKindForExtension(resource.extension)) !== "pdf") {
    return res.redirect("/");
  }

  res.type("html").send(renderReaderHtml(resource.id, {
    authenticated: Boolean(session && (session.role === "admin" || session.approved)),
    csrfToken: session ? session.csrfToken : "",
    username: session ? session.user : "",
    role: session ? session.role : ""
  }));
});

app.get("/thumbnails/:id.png", async (req, res) => {
  req.adminSession = getSession(req);
  const resource = await visibleResource(req, req.params.id);

  if (!resource) {
    return res.status(404).send("Thumbnail not found.");
  }

  try {
    const thumbnailPath = path.join(THUMB_DIR, `${resource.id}.png`);
    const stat = await fsp.lstat(thumbnailPath).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      return res.status(404).send("Thumbnail is still processing or unavailable.");
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.type("png").sendFile(thumbnailPath);
  } catch (error) {
    safeLogError("thumbnail delivery failed", error);
    res.status(500).send("Thumbnail generation failed.");
  }
});

app.get("/files/:id", async (req, res) => {
  req.adminSession = getSession(req);
  const resource = await visibleResource(req, req.params.id);

  if (!resource) {
    return res.status(404).send("File not found.");
  }

  const resolved = resolveResourceFile(resource);

  if (!resolved) {
    return res.status(400).send("Invalid file path.");
  }

  const type = mimeTypes[resource.extension] || "application/octet-stream";
  const disposition = req.query.download ? "attachment" : "inline";

  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(resource.originalName)}"`);
  res.sendFile(resolved);
});

app.get("/assets/pdf.mjs", allowPublic, (_req, res) => {
  res.type("text/javascript").sendFile(path.join(ROOT, "node_modules", "pdfjs-dist", "build", "pdf.mjs"));
});

app.get("/assets/pdf.worker.mjs", allowPublic, (_req, res) => {
  res.type("text/javascript").sendFile(
    path.join(ROOT, "node_modules", "pdfjs-dist", "build", "pdf.worker.mjs")
  );
});

app.get("/api/admin/uploads-backup.zip", requireAdmin, async (req, res) => {
  const resources = await readIndex();
  const zip = new JSZip();
  const manifest = {
    format: "mafusheets-upload-backup-v1",
    createdAt: new Date().toISOString(),
    resources: resources.map((resource) => fullResource(resource))
  };

  for (const resource of resources) {
    const source = resolveResourceFile(resource);
    if (!source) continue;
    const stat = await fsp.lstat(source).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue;
    const folder = String(resource.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = path.basename(resource.originalName || resource.storedName);
    zip.file(`uploads/${folder}/${filename}`, fs.createReadStream(source));
  }

  zip.file("backup-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  recordAudit(req, "maintenance_requested", "catalog", null, { operation: "uploads_backup" });
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="mafusheets-uploads-${date}.zip"`);
  zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE" })
    .on("error", (error) => {
      safeLogError("uploads backup failed", error);
      if (!res.headersSent) res.status(500).send("Backup generation failed.");
      else res.destroy(error);
    })
    .pipe(res);
});

app.use((error, _req, res, next) => {
  if (!error) {
    return next();
  }

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `One of the files is over the ${MAX_FILE_SIZE} byte limit.` });
    }

    if (error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ error: `Upload up to ${MAX_FILES_PER_UPLOAD} files at a time.` });
    }

    return res.status(400).json({ error: "The upload could not be processed." });
  }

  safeLogError("request failed", error);
  res.status(500).json({ error: "Something went wrong." });
});

app.use((req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(404).json({ error: "Not found." });
  }

  return res.status(404).type("html").send(renderMainHtml({
    authenticated: true,
    csrfToken: session.csrfToken,
    username: session.user,
    userId: session.userId,
    role: session.role,
    mustChangePassword: session.mustChangePassword
  }));
});

function renderReaderHtml(
  resourceId,
  { authenticated = false, csrfToken = "", username = "", role = "" } = {}
) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MafuSheets Reader</title>
  <link rel="icon" type="image/png" href="/assets/logo.png">
  <style>
    :root {
      color-scheme: dark;
      --accent: #2b0476;
      --accent-light: #7c4dff;
      --bg: #090a0d;
      --panel: #15171d;
      --line: #30333d;
      --text: #f2f4f8;
      --muted: #aeb4c1;
      --danger: #ff6b6b;
      --ok: #79d99b;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
    }

    button, input, select, textarea { font: inherit; }
    a { color: inherit; text-decoration: none; }

    .reader {
      display: grid;
      grid-template-rows: 54px minmax(0, 1fr);
      height: 100vh;
      background: #050609;
    }

    .reader-bar {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      border-bottom: 1px solid var(--line);
      background: rgba(13, 15, 20, .96);
      padding: 7px 10px;
      z-index: 3;
    }

    .reader-title {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
    }

    .reader-title strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: .98rem;
    }

    .reader-meta {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: .82rem;
    }

    .reader-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .icon-button, .text-button {
      min-height: 38px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #14161b;
      color: var(--text);
      cursor: pointer;
    }

    .icon-button {
      width: 40px;
      display: grid;
      place-items: center;
      font-size: 1.1rem;
      line-height: 1;
    }

    .text-button {
      display: inline-grid;
      place-items: center;
      padding: 0 12px;
      font-size: .88rem;
    }

    .primary {
      min-height: 42px;
      border: 0;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--accent), #4a16b6);
      color: #fff;
      font-weight: 750;
      cursor: pointer;
    }

    .reader-stage {
      position: relative;
      min-width: 0;
      min-height: 0;
    }

    .pdf-frame {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: #1d1f24;
    }

    .mobile-pdf {
      display: none;
    }

    .drawer {
      position: fixed;
      top: 54px;
      right: 0;
      bottom: 0;
      width: min(420px, calc(100vw - 20px));
      border-left: 1px solid var(--line);
      background: rgba(18, 20, 26, .98);
      box-shadow: -18px 0 45px rgba(0, 0, 0, .35);
      transform: translateX(100%);
      transition: transform .18s ease;
      z-index: 4;
      overflow: auto;
    }

    body.drawer-open .drawer {
      transform: translateX(0);
    }

    .drawer-head {
      position: sticky;
      top: 0;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 14px;
      border-bottom: 1px solid var(--line);
      background: rgba(18, 20, 26, .98);
      z-index: 1;
    }

    .drawer-head h2 {
      margin: 0;
      font-size: 1rem;
    }

    .drawer-body {
      display: grid;
      gap: 14px;
      padding: 14px;
    }

    .section {
      display: grid;
      gap: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #101218;
      padding: 14px;
    }

    .section h3 {
      margin: 0;
      font-size: .96rem;
    }

    form {
      display: grid;
      gap: 12px;
    }

    label {
      display: grid;
      gap: 7px;
      color: var(--muted);
      font-size: .86rem;
    }

    input, select, textarea {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b0c10;
      color: var(--text);
      padding: 10px 12px;
      outline: none;
    }

    textarea {
      min-height: 94px;
      resize: vertical;
    }

    input:focus, select:focus, textarea:focus {
      border-color: var(--accent-light);
      box-shadow: 0 0 0 3px rgba(124, 77, 255, .18);
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .message {
      min-height: 22px;
      color: var(--muted);
      font-size: .86rem;
      line-height: 1.4;
    }

    .message.error { color: var(--danger); }
    .message.ok { color: var(--ok); }

    .annotation-list {
      display: grid;
      gap: 10px;
    }

    .annotation-item {
      display: grid;
      gap: 7px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #15171d;
    }

    .annotation-item header {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      color: var(--muted);
      font-size: .8rem;
    }

    .annotation-item p {
      margin: 0;
      line-height: 1.45;
    }

    .empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 18px;
      text-align: center;
    }

    @media (max-width: 720px) {
      body {
        height: auto;
        min-height: 100dvh;
        overflow: auto;
      }

      .reader {
        grid-template-rows: auto minmax(calc(100dvh - 150px), auto);
        min-height: 100dvh;
        height: auto;
      }

      .reader-bar {
        grid-template-columns: auto 1fr;
        gap: 10px;
        padding: 9px 10px 12px;
      }

      .reader-title {
        grid-column: 2;
        display: grid;
        gap: 2px;
      }

      .reader-actions {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .reader-actions .text-button,
      .reader-actions .primary {
        width: 100%;
        min-height: 44px;
        padding: 7px 10px;
        text-align: center;
      }

      .reader-auth-badge {
        grid-column: 1 / -1;
      }

      .pdf-frame {
        display: none;
      }

      .mobile-pdf {
        display: grid;
        gap: 12px;
        min-height: calc(100dvh - 150px);
        padding: 12px;
        background: #1d1f24;
      }

      .pdf-page {
        display: block;
        width: 100%;
        height: auto;
        background: #fff;
        box-shadow: 0 2px 12px rgba(0, 0, 0, .35);
      }

      .pdf-status {
        align-self: start;
        color: var(--muted);
        padding: 20px;
        text-align: center;
      }

      .drawer {
        top: 0;
        width: 100%;
        border-left: 0;
      }

      .grid-2 {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body data-authenticated="${authenticated ? "1" : "0"}" data-role="${escapeHtmlText(role)}">
  <main class="reader">
    <header class="reader-bar">
      <a class="icon-button" href="/" title="Back to library" aria-label="Back to library">&larr;</a>
      <div class="reader-title">
        <strong id="readerTitle">Loading sheet...</strong>
        <span class="reader-meta" id="readerMeta"></span>
      </div>
      <div class="reader-actions">
        <span class="text-button reader-auth-badge" id="readerAuthBadge" aria-hidden="true">${authenticated ? `Admin: ${escapeHtmlText(username || "admin")}` : "Admin login needed"}</span>
        <a class="text-button" id="rawPdfLink" href="#" target="_blank" rel="noopener">Open in new tab</a>
        <a class="text-button" id="downloadLink" href="#">Download</a>
        <button class="primary" id="toggleDrawer" type="button">Edit / notes</button>
      </div>
    </header>

    <section class="reader-stage">
      <iframe class="pdf-frame" id="pdfFrame" title="PDF sheet"></iframe>
      <div class="mobile-pdf" id="mobilePdf" aria-label="PDF pages">
        <div class="pdf-status" id="pdfStatus">Loading PDF pages...</div>
      </div>
    </section>
  </main>

  <aside class="drawer" id="drawer" aria-label="Sheet details">
    <div class="drawer-head">
      <h2>Sheet details</h2>
      <button class="icon-button" id="closeDrawer" type="button" aria-label="Close details">x</button>
    </div>
    <div class="drawer-body">
      <section class="section">
        <h3>Admin access</h3>
        <div class="message" id="readerAuthMessage"></div>
      </section>

      <section class="section">
        <h3>Metadata</h3>
        <form id="detailForm">
          <label>
            Title
            <input id="titleInput" name="title" maxlength="120" required>
          </label>
          <label>
            Artist / source
            <input id="artistInput" name="artist" maxlength="120">
          </label>
          <div class="grid-2">
            <label>
              Key
              <input id="keyInput" name="key" maxlength="24">
            </label>
            <label>
              Capo
              <input id="capoInput" name="capo" type="number" min="0" max="24" step="1">
            </label>
          </div>
          <label>
            BPM
            <input id="bpmInput" name="bpm" type="number" min="20" max="400" step="1">
          </label>
          <label>
            Tags
            <input id="tagsInput" name="tags" maxlength="300" placeholder="Comma-separated tags">
          </label>
          <label>
            Notes
            <textarea id="notesInput" name="notes" maxlength="2500"></textarea>
          </label>
          <button class="primary" id="saveButton" type="submit">Save changes</button>
          <button class="secondary danger" id="deleteButton" type="button">Delete sheet</button>
          ${role === "admin"
            ? '<button class="secondary" id="visibilityButton" type="button">Publish to guest library</button>'
            : ""}
          <div class="message" id="detailMessage"></div>
        </form>
      </section>

      <section class="section">
        <h3>Page notes</h3>
        <form id="annotationForm">
          <div class="grid-2">
            <label>
              Page
              <input id="annotationPageInput" name="page" type="number" min="1" step="1" required placeholder="1">
            </label>
            <label>
              Color
              <select id="annotationColorInput" name="color">
                <option value="amber">Amber</option>
                <option value="green">Green</option>
                <option value="blue">Blue</option>
                <option value="pink">Pink</option>
              </select>
            </label>
          </div>
          <label>
            Note
            <textarea id="annotationTextInput" name="text" maxlength="500" required placeholder="Example: repeat the refrain here"></textarea>
          </label>
          <button class="text-button" type="submit">Add note</button>
        </form>
        <div class="annotation-list" id="annotationList"></div>
      </section>
    </div>
  </aside>

  <script>
    const resourceId = ${JSON.stringify(resourceId)};
    const authState = ${JSON.stringify({
      authenticated,
      csrfToken,
      username: username || "",
      role: role || ""
    })};
    const kindLabels = { pdf: "PDF", image: "Image", chart: "Chart", other: "Other" };
    const readerTitle = document.querySelector("#readerTitle");
    const readerMeta = document.querySelector("#readerMeta");
    const pdfFrame = document.querySelector("#pdfFrame");
    const mobilePdf = document.querySelector("#mobilePdf");
    const pdfStatus = document.querySelector("#pdfStatus");
    const rawPdfLink = document.querySelector("#rawPdfLink");
    const downloadLink = document.querySelector("#downloadLink");
    const readerAuthBadge = document.querySelector("#readerAuthBadge");
    const readerAuthMessage = document.querySelector("#readerAuthMessage");
    const toggleDrawer = document.querySelector("#toggleDrawer");
    const closeDrawer = document.querySelector("#closeDrawer");
    const detailForm = document.querySelector("#detailForm");
    const titleInput = document.querySelector("#titleInput");
    const artistInput = document.querySelector("#artistInput");
    const keyInput = document.querySelector("#keyInput");
    const capoInput = document.querySelector("#capoInput");
    const bpmInput = document.querySelector("#bpmInput");
    const tagsInput = document.querySelector("#tagsInput");
    const notesInput = document.querySelector("#notesInput");
    const detailMessage = document.querySelector("#detailMessage");
    const deleteButton = document.querySelector("#deleteButton");
    const visibilityButton = document.querySelector("#visibilityButton");
    const annotationForm = document.querySelector("#annotationForm");
    const annotationPageInput = document.querySelector("#annotationPageInput");
    const annotationTextInput = document.querySelector("#annotationTextInput");
    const annotationColorInput = document.querySelector("#annotationColorInput");
    const annotationList = document.querySelector("#annotationList");
    let resource = null;
    let renderedPdfUrl = "";

    async function renderMobilePdf(url) {
      if (!window.matchMedia("(max-width: 720px)").matches || renderedPdfUrl === url) return;
      renderedPdfUrl = url;
      pdfStatus.textContent = "Loading PDF pages...";
      try {
        const pdfjs = await import("/assets/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.mjs";
        const pdf = await pdfjs.getDocument({ url, withCredentials: true }).promise;
        mobilePdf.replaceChildren();
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          const displayWidth = Math.max(280, mobilePdf.clientWidth - 24);
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          const viewport = page.getViewport({
            scale: displayWidth * pixelRatio / baseViewport.width
          });
          const canvas = document.createElement("canvas");
          canvas.className = "pdf-page";
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.aspectRatio = String(viewport.width) + " / " + String(viewport.height);
          canvas.setAttribute("aria-label", "Page " + String(pageNumber));
          mobilePdf.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        }
      } catch (_error) {
        renderedPdfUrl = "";
        pdfStatus.textContent = "This PDF could not be displayed here. Use Open in new tab or Download.";
        mobilePdf.replaceChildren(pdfStatus);
      }
    }

    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"']/g, function(char) {
        return ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        })[char];
      });
    }

    function setReaderAuthUi(nextState) {
      authState.authenticated = Boolean(nextState && nextState.authenticated);
      authState.csrfToken = nextState && nextState.csrfToken ? String(nextState.csrfToken) : "";
      authState.username = nextState && nextState.user ? String(nextState.user) : "";
      authState.role = nextState && nextState.role ? String(nextState.role) : authState.role || "";
      document.body.dataset.authenticated = authState.authenticated ? "1" : "0";
      readerAuthBadge.textContent = authState.authenticated
        ? "Admin: " + (authState.username || "admin")
        : "Admin login needed";
      readerAuthMessage.textContent = authState.authenticated
        ? "Signed in as " + (authState.username || "admin") + "."
        : "Sign in on the library page to edit metadata, add notes, or delete this sheet.";

      const controls = detailForm.querySelectorAll("input, select, textarea, button");
      controls.forEach(function(control) {
        if (control.id === "closeDrawer") return;
        control.disabled = !authState.authenticated && control !== toggleDrawer;
      });
      deleteButton.disabled = !authState.authenticated;
      document.querySelectorAll("#annotationForm input, #annotationForm select, #annotationForm textarea, #annotationForm button")
        .forEach(function(control) {
          control.disabled = !authState.authenticated;
        });
    }

    async function apiFetch(url, options = {}) {
      const headers = new Headers(options.headers || {});
      if (options.method && options.method !== "GET" && authState.csrfToken) {
        headers.set("X-CSRF-Token", authState.csrfToken);
      }

      return fetch(url, {
        credentials: "same-origin",
        ...options,
        headers
      });
    }

    function splitTags(value) {
      return String(value || "")
        .split(",")
        .map(function(tag) { return tag.trim(); })
        .filter(Boolean)
        .slice(0, 24);
    }

    function setDetailMessage(text, kind) {
      detailMessage.textContent = text || "";
      detailMessage.className = "message" + (kind ? " " + kind : "");
    }

    function metaLine(item) {
      const parts = [];
      if (item.artist) parts.push(item.artist);
      if (item.key) parts.push("Key " + item.key);
      if (item.capo !== null && item.capo !== undefined && item.capo !== "") parts.push("Capo " + item.capo);
      if (item.bpm !== null && item.bpm !== undefined && item.bpm !== "") parts.push(item.bpm + " BPM");
      parts.push(kindLabels[item.sheetKind] || "Sheet");
      return parts.join(" | ");
    }

    function fillForm(item) {
      titleInput.value = item.title || "";
      artistInput.value = item.artist || "";
      keyInput.value = item.key || "";
      capoInput.value = item.capo === null || item.capo === undefined ? "" : item.capo;
      bpmInput.value = item.bpm === null || item.bpm === undefined ? "" : item.bpm;
      tagsInput.value = Array.isArray(item.tags) ? item.tags.join(", ") : "";
      notesInput.value = item.notes || "";
    }

    function renderAnnotations(annotations) {
      if (!Array.isArray(annotations) || !annotations.length) {
        annotationList.innerHTML = '<div class="empty">No page notes yet.</div>';
        return;
      }

      const sorted = annotations.slice().sort(function(a, b) {
        return (a.page - b.page) || new Date(a.createdAt) - new Date(b.createdAt);
      });

      annotationList.innerHTML = sorted.map(function(annotation) {
        return '<article class="annotation-item">' +
          '<header><span>Page ' + escapeHtml(annotation.page) + '</span><span>' + escapeHtml(annotation.color || "amber") + '</span></header>' +
          '<p>' + escapeHtml(annotation.text) + '</p>' +
          '<button class="text-button" type="button" data-delete-annotation="' + escapeHtml(annotation.id) + '"' + (authState.authenticated ? "" : " disabled") + '>Delete</button>' +
        '</article>';
      }).join("");
    }

    function renderResource(item) {
      document.title = (item.title || "Sheet") + " - MafuSheets";
      readerTitle.textContent = item.title || "Sheet";
      readerMeta.textContent = metaLine(item);
      rawPdfLink.href = item.viewUrl;
      downloadLink.href = item.downloadUrl;
      if (pdfFrame.src !== item.viewUrl) {
        pdfFrame.src = item.viewUrl;
      }
      renderMobilePdf(item.viewUrl);
      fillForm(item);
      renderAnnotations(item.annotations || []);
      if (visibilityButton) {
        visibilityButton.textContent = item.visibility === "guest"
          ? "Remove from guest library" : "Publish to guest library";
      }
    }

    async function loadResource() {
      const response = await apiFetch("/api/resources/" + encodeURIComponent(resourceId));
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not load sheet.");
      }

      resource = result.resource;
      renderResource(resource);
    }

    async function saveDetails(event) {
      event.preventDefault();
      setDetailMessage("Saving changes...");
      const body = {
        title: titleInput.value,
        artist: artistInput.value,
        key: keyInput.value,
        capo: capoInput.value,
        bpm: bpmInput.value,
        tags: splitTags(tagsInput.value),
        notes: notesInput.value
      };

      const response = await apiFetch("/api/resources/" + encodeURIComponent(resourceId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not save changes.");
      }

      resource = result.resource;
      renderResource(resource);
      setDetailMessage("Saved.", "ok");
    }

    async function addAnnotation(event) {
      event.preventDefault();
      const body = {
        page: annotationPageInput.value,
        color: annotationColorInput.value,
        text: annotationTextInput.value
      };

      const response = await apiFetch("/api/resources/" + encodeURIComponent(resourceId) + "/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not save note.");
      }

      annotationPageInput.value = "";
      annotationTextInput.value = "";
      annotationColorInput.value = "amber";
      setDetailMessage("Note saved.", "ok");
      await loadResource();
    }

    async function deleteAnnotation(annotationId) {
      const response = await apiFetch("/api/resources/" + encodeURIComponent(resourceId) + "/annotations/" + encodeURIComponent(annotationId), {
        method: "DELETE"
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not delete note.");
      }

      setDetailMessage("Note deleted.", "ok");
      await loadResource();
    }

    async function deleteResource() {
      if (!window.confirm("Delete this sheet permanently?")) return;

      setDetailMessage("Deleting sheet...");
      const response = await apiFetch("/api/resources/" + encodeURIComponent(resourceId), {
        method: "DELETE"
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not delete sheet.");
      }

      setDetailMessage("Sheet deleted.", "ok");
      window.location.href = "/";
    }

    async function changeResourceVisibility() {
      if (!resource || authState.role !== "admin" || !visibilityButton) return;
      const visibility = resource.visibility === "guest" ? "restricted" : "guest";
      visibilityButton.disabled = true;
      try {
        const response = await apiFetch(
          "/api/admin/resources/" + encodeURIComponent(resource.id) + "/visibility",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ visibility: visibility })
          }
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not change visibility.");
        resource.visibility = result.visibility;
        visibilityButton.textContent = result.visibility === "guest"
          ? "Remove from guest library" : "Publish to guest library";
        setDetailMessage(result.visibility === "guest"
          ? "Published to the guest library." : "Restricted to approved members.", "ok");
      } catch (error) {
        setDetailMessage(error.message, "error");
      } finally {
        visibilityButton.disabled = false;
      }
    }

    toggleDrawer.addEventListener("click", function() {
      document.body.classList.toggle("drawer-open");
    });

    closeDrawer.addEventListener("click", function() {
      document.body.classList.remove("drawer-open");
    });

    detailForm.addEventListener("submit", function(event) {
      saveDetails(event).catch(function(error) {
        setDetailMessage(error.message, "error");
      });
    });

    deleteButton.addEventListener("click", function() {
      deleteResource().catch(function(error) {
        setDetailMessage(error.message, "error");
      });
    });

    if (visibilityButton) {
      visibilityButton.addEventListener("click", changeResourceVisibility);
    }

    annotationForm.addEventListener("submit", function(event) {
      addAnnotation(event).catch(function(error) {
        setDetailMessage(error.message, "error");
      });
    });

    annotationList.addEventListener("click", function(event) {
      const button = event.target.closest("[data-delete-annotation]");
      if (!button) return;
      deleteAnnotation(button.dataset.deleteAnnotation).catch(function(error) {
        setDetailMessage(error.message, "error");
      });
    });

    document.addEventListener("keydown", function(event) {
      if (event.key === "Escape") {
        document.body.classList.remove("drawer-open");
      }
    });

    setReaderAuthUi(authState);
    loadResource().catch(function(error) {
      readerTitle.textContent = "Could not load sheet";
      readerMeta.textContent = error.message;
    });
  </script>
</body>
</html>`;
}

function renderLoginHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MafuSheets Login</title>
  <link rel="icon" type="image/png" href="/assets/logo.png">
  <style>
    :root {
      color-scheme: dark;
      --accent: #2b0476;
      --accent-light: #7c4dff;
      --bg: #111216;
      --panel: #191b21;
      --line: #30333d;
      --text: #f2f4f8;
      --muted: #aeb4c1;
      --shadow: 0 18px 50px rgba(0, 0, 0, .28);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top left, rgba(43, 4, 118, .38), transparent 34rem),
        linear-gradient(145deg, #101116 0%, #17191f 52%, #101116 100%);
      color: var(--text);
      padding: 20px;
    }

    .login {
      width: min(440px, 100%);
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(25, 27, 33, .94);
      box-shadow: var(--shadow);
      padding: 22px;
      display: grid;
      gap: 18px;
    }

    .login-head {
      display: flex;
      gap: 14px;
      align-items: center;
    }

    .login-head img {
      width: 58px;
      height: 58px;
      border-radius: 10px;
      object-fit: cover;
      border: 1px solid rgba(124, 77, 255, .26);
      background: #120d23;
    }

    .login-head h1 {
      margin: 0 0 4px;
      font-size: 1.15rem;
    }

    .login-head p {
      margin: 0;
      color: var(--muted);
      font-size: .92rem;
      line-height: 1.5;
    }

    form {
      display: grid;
      gap: 12px;
    }

    label {
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-size: .88rem;
    }

    input {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #111318;
      color: var(--text);
      padding: 10px 12px;
      outline: none;
    }

    input:focus {
      border-color: var(--accent-light);
      box-shadow: 0 0 0 3px rgba(124, 77, 255, .18);
    }

    button {
      min-height: 46px;
      border: 0;
      border-radius: 8px;
      font-weight: 750;
      cursor: pointer;
      background: linear-gradient(135deg, var(--accent), #4a16b6);
      color: white;
    }

    .message {
      min-height: 22px;
      color: var(--muted);
      font-size: .9rem;
      line-height: 1.45;
    }

    .message.error { color: #ff6b6b; }
    .message.ok { color: #79d99b; }
  </style>
</head>
<body>
  <main class="login">
    <div class="login-head">
      <img src="/assets/logo.png" alt="">
      <div>
        <h1>MafuSheets</h1>
        <p>Sign in to access the sheet library, reader, and downloads.</p>
      </div>
    </div>

    <form id="loginForm">
      <label>
        Username
        <input id="loginUserInput" name="username" autocomplete="username" required>
      </label>
      <label>
        Password
        <input id="loginPasswordInput" name="password" type="password" autocomplete="current-password" required>
      </label>
      <button id="loginButton" type="submit">Sign in</button>
      <div class="message" id="loginMessage"></div>
    </form>
  </main>

  <script>
    const loginForm = document.querySelector("#loginForm");
    const loginUserInput = document.querySelector("#loginUserInput");
    const loginPasswordInput = document.querySelector("#loginPasswordInput");
    const loginButton = document.querySelector("#loginButton");
    const loginMessage = document.querySelector("#loginMessage");

    loginForm.addEventListener("submit", async function(event) {
      event.preventDefault();
      loginButton.disabled = true;
      loginMessage.textContent = "Signing in...";
      loginMessage.className = "message";

      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: loginUserInput.value,
            password: loginPasswordInput.value
          })
        });
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || "Could not sign in.");
        }

        loginMessage.textContent = "Signed in.";
        loginMessage.className = "message ok";
        window.location.href = "/";
      } catch (error) {
        loginMessage.textContent = error.message;
        loginMessage.className = "message error";
      } finally {
        loginButton.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function renderMainHtml({
  authenticated = false, csrfToken = "", username = "", displayName = "", userId = "", role = "",
  approved = false, mustChangePassword = false
} = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MafuSheets</title>
  <link rel="icon" type="image/png" href="/assets/logo.png">
  <link rel="apple-touch-icon" href="/assets/logo.png">
  <style>
    :root {
      color-scheme: dark;
      --accent: #2b0476;
      --accent-light: #7c4dff;
      --bg: #111216;
      --panel: #191b21;
      --panel-soft: #20232b;
      --line: #30333d;
      --text: #f2f4f8;
      --muted: #aeb4c1;
      --danger: #ff6b6b;
      --ok: #79d99b;
      --shadow: 0 18px 50px rgba(0, 0, 0, .28);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(43, 4, 118, .38), transparent 34rem),
        linear-gradient(145deg, #101116 0%, #17191f 52%, #101116 100%);
      color: var(--text);
    }

    a { color: inherit; }
    button, input, select, textarea { font: inherit; }

    .shell {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 36px 0 48px;
    }

    .topbar {
      margin-bottom: 18px;
    }

    .hero-card {
      position: relative;
      height: 240px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        linear-gradient(90deg, rgba(17, 18, 22, .16), rgba(17, 18, 22, .44)),
        #150a33;
      box-shadow: var(--shadow);
    }

    .hero-card img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .hero-copy {
      position: absolute;
      left: 32px;
      right: 32px;
      bottom: 24px;
      display: grid;
      gap: 8px;
      max-width: 720px;
    }

    .hero-copy h1 {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .hero-copy .brandline {
      margin: 0;
      font-size: clamp(2rem, 6vw, 4.2rem);
      line-height: .95;
      letter-spacing: 0;
      font-weight: 800;
      color: #fff;
      text-shadow: 0 2px 14px rgba(0, 0, 0, .52);
    }

    .hero-copy p {
      margin: 0;
      color: #f5f1ff;
      font-size: 1.02rem;
      line-height: 1.55;
      text-shadow: 0 2px 12px rgba(0, 0, 0, .55);
      max-width: 60ch;
    }

    .library-title {
      display: flex;
      gap: 8px;
      align-items: baseline;
    }

    .library-title h1 {
      margin: 0;
      font-size: 1.08rem;
    }

    .sheet-count {
      color: var(--muted);
      font-size: .84rem;
      white-space: nowrap;
    }

    .layout {
      display: block;
    }

    .panel {
      border: 1px solid var(--line);
      background: rgba(25, 27, 33, .86);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .upload-panel {
      padding: 18px;
    }

    .actions-dialog {
      width: min(620px, calc(100vw - 24px));
      max-height: calc(100vh - 24px);
      overflow: auto;
      padding: 0;
      border: 0;
      border-radius: 12px;
      color: var(--text);
      background: transparent;
    }

    .actions-dialog::backdrop {
      background: rgba(5, 6, 9, .76);
      backdrop-filter: blur(4px);
    }

    .actions-dialog .upload-panel { box-shadow: var(--shadow); }
    .panel-title .close { flex: 0 0 auto; }

    body[data-authenticated="0"] #actionsDialog {
      width: min(460px, calc(100vw - 24px));
    }

    .tab-panels {
      display: grid;
      gap: 14px;
      margin-top: 14px;
    }

    .tab-panel {
      display: none;
      gap: 14px;
    }

    .tab-panel.active {
      display: grid;
    }

    .panel-subtitle {
      margin: 0;
      color: var(--muted);
      font-size: .85rem;
      line-height: 1.45;
    }

    .admin-stack {
      display: grid;
      gap: 12px;
    }

    .admin-stack[hidden] {
      display: none;
    }

    body[data-authenticated="0"] #sideTabs,
    body[data-authenticated="0"] #authBadge,
    body[data-authenticated="0"] #actionsSubtitle {
      display: none;
    }

    .admin-meta {
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #111318;
    }

    .admin-meta strong {
      font-size: .98rem;
    }

    .signin-intro {
      margin: -2px 0 2px;
      color: var(--muted);
      font-size: .92rem;
      line-height: 1.5;
    }

    .admin-actions {
      display: grid;
      gap: 10px;
    }

    .admin-actions .secondary,
    .admin-actions .primary,
    .admin-actions .backup-link {
      width: 100%;
    }

    .backup-link {
      display: inline-grid;
      place-items: center;
      text-decoration: none;
    }

    body[data-authenticated="1"] .guest-only,
    body:not([data-authenticated="1"]) .auth-only {
      display: none;
    }

    body:not([data-authenticated="1"]) .requires-auth {
      display: none;
    }

    body:not([data-approved="1"]):not([data-role="admin"]) .requires-approved {
      display: none !important;
    }

    body:not([data-role="admin"]) .admin-only {
      display: none !important;
    }

    .upload-logo {
      width: 58px;
      height: 58px;
      border-radius: 8px;
      object-fit: cover;
      border: 1px solid rgba(124, 77, 255, .26);
      background: #120d23;
    }

    .panel-title {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 18px;
    }

    .panel-title h2 {
      margin: 0;
      font-size: 1.05rem;
      letter-spacing: 0;
    }

    .pill {
      border: 1px solid rgba(124, 77, 255, .42);
      background: rgba(43, 4, 118, .38);
      color: #ddd5ff;
      padding: 5px 8px;
      border-radius: 999px;
      font-size: .78rem;
      white-space: nowrap;
    }

    form { display: grid; gap: 14px; }

    label {
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-size: .88rem;
    }

    input, select, textarea {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #111318;
      color: var(--text);
      padding: 10px 12px;
      outline: none;
    }

    textarea {
      min-height: 96px;
      resize: vertical;
    }

    input:focus, select:focus, textarea:focus {
      border-color: var(--accent-light);
      box-shadow: 0 0 0 3px rgba(124, 77, 255, .18);
    }

    input[type="file"] {
      padding: 11px;
      min-height: auto;
    }

    input[type="checkbox"] {
      width: auto;
      min-height: auto;
      margin-right: 6px;
    }

    .hint {
      margin: -4px 0 0;
      color: var(--muted);
      font-size: .82rem;
      line-height: 1.45;
    }

    .primary, .secondary {
      min-height: 46px;
      border: 0;
      border-radius: 8px;
      font-weight: 750;
      cursor: pointer;
      transition: transform .15s ease, border-color .15s ease, background-color .15s ease,
        box-shadow .15s ease;
    }

    .primary {
      background: linear-gradient(135deg, var(--accent), #4a16b6);
      color: white;
    }

    .secondary {
      border: 1px solid var(--line);
      background: #15171d;
      color: var(--text);
    }

    .danger {
      border-color: rgba(255, 107, 107, .45);
      color: #ffd4d4;
    }

    .primary:disabled, .secondary:disabled {
      cursor: wait;
      opacity: .72;
    }

    .message {
      min-height: 22px;
      color: var(--muted);
      font-size: .9rem;
      line-height: 1.45;
    }

    .message.error { color: var(--danger); }
    .message.ok { color: var(--ok); }

    .library { min-width: 0; }

    .controls {
      display: grid;
      gap: 12px;
      padding: 16px;
      border-bottom: 1px solid var(--line);
    }

    .library-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .library-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .library-state {
      grid-column: 1 / -1;
      padding: 36px 18px;
      text-align: center;
      color: var(--muted);
    }

    .library-state.error { color: var(--danger); }
    .library-state .action { margin-top: 14px; }

    .tabs {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 2px;
    }

    .view-toggle {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .browse-tools {
      display: grid;
      grid-template-columns: auto minmax(220px, 1fr) minmax(160px, auto);
      gap: 12px;
      align-items: end;
    }

    .browse-tools label { min-width: 0; }

    .user-management {
      display: grid;
      gap: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
    }

    .user-management h3 { margin: 0; font-size: 1rem; }

    .user-list { display: grid; gap: 8px; }

    .user-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px 12px;
      align-items: start;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #14161b;
    }

    .user-row strong, .user-row span { overflow-wrap: break-word; }
    .user-row .hint { margin: 2px 0 0; }
    .user-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: start; }
    .user-actions .secondary { min-height: 38px; padding: 6px 10px; }

    .tab {
      border: 1px solid var(--line);
      background: #14161b;
      color: var(--muted);
      min-height: 38px;
      padding: 0 14px;
      border-radius: 8px;
      cursor: pointer;
      white-space: nowrap;
      transition: transform .15s ease, border-color .15s ease, background-color .15s ease,
        color .15s ease;
    }

    .tab.active {
      border-color: rgba(124, 77, 255, .62);
      background: rgba(43, 4, 118, .82);
      color: #fff;
    }

    .resource-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      padding: 16px;
    }

    .resource-grid.list-view {
      display: block;
      padding: 8px 16px 16px;
    }

    .card {
      display: grid;
      grid-template-rows: 148px 1fr;
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
      transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease;
    }

    .resource-grid.list-view .card {
      display: grid;
      grid-template-columns: minmax(150px, 1.4fr) minmax(180px, 1fr) auto;
      gap: 12px;
      align-items: center;
      min-height: 52px;
      padding: 7px 10px;
      margin-top: 6px;
      border-radius: 6px;
    }

    .preview {
      display: grid;
      place-items: center;
      background: #12141a;
      border-bottom: 1px solid var(--line);
      overflow: hidden;
      color: var(--muted);
      font-weight: 800;
      text-decoration: none;
      width: 100%;
      padding: 0;
      border: 0;
      cursor: pointer;
      appearance: none;
    }

    .preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .preview img.pdf-thumb {
      object-fit: contain;
      padding: 10px;
      background: #f3f4f7;
    }

    .preview img.image-thumb {
      object-fit: contain;
      padding: 10px;
      background: #12141a;
    }

    .preview .filemark {
      width: 72px;
      height: 88px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      border: 1px solid rgba(124, 77, 255, .42);
      background: rgba(43, 4, 118, .32);
      color: #e5dcff;
      text-transform: uppercase;
      font-size: .95rem;
      padding: 0 8px;
      text-align: center;
      line-height: 1.2;
    }

    .card-body {
      display: grid;
      gap: 10px;
      padding: 12px;
      min-width: 0;
    }

    .resource-grid.list-view .card-body {
      display: contents;
    }

    .resource-grid.list-view .card h3 { font-size: .93rem; }
    .resource-grid.list-view .meta {
      display: block;
      font-size: .78rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .resource-grid.list-view .meta span { display: inline; }
    .resource-grid.list-view .meta span + span::before { content: " · "; }
    .resource-grid.list-view .chips { display: none; }
    .resource-grid.list-view .actions {
      margin: 0;
      flex-wrap: nowrap;
      justify-content: end;
    }
    .resource-grid.list-view .action { min-height: 38px; }

    .thumbnail-placeholder {
      display: grid;
      place-items: center;
      width: 100%;
      height: 100%;
      min-height: 120px;
      padding: 12px;
      text-align: center;
      color: var(--muted);
      background: #12141a;
      font-size: .82rem;
    }

    .card h3 {
      margin: 0;
      font-size: 1rem;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }

    .meta {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: .82rem;
      min-width: 0;
    }

    .meta span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chips {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      background: rgba(124, 77, 255, .14);
      border: 1px solid rgba(124, 77, 255, .24);
      color: #dfd6ff;
      font-size: .75rem;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: auto;
    }

    .action {
      display: inline-grid;
      place-items: center;
      min-height: 34px;
      border-radius: 8px;
      padding: 0 10px;
      border: 1px solid var(--line);
      background: #15171d;
      color: var(--text);
      text-decoration: none;
      font-size: .86rem;
      cursor: pointer;
      transition: transform .15s ease, border-color .15s ease, background-color .15s ease;
    }

    @media (hover: hover) and (pointer: fine) {
      .card:hover {
        transform: translateY(-2px);
        border-color: rgba(124, 77, 255, .5);
        box-shadow: 0 12px 28px rgba(0, 0, 0, .24);
      }

      .primary:hover, .secondary:hover, .tab:hover, .action:hover, .close:hover {
        transform: translateY(-1px);
        border-color: rgba(124, 77, 255, .58);
      }

      .primary:hover {
        box-shadow: 0 8px 20px rgba(43, 4, 118, .34);
      }
    }

    .empty {
      padding: 44px 18px;
      text-align: center;
      color: var(--muted);
    }

    .dialog {
      width: min(1100px, calc(100vw - 18px));
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #15171d;
      color: var(--text);
      box-shadow: var(--shadow);
      padding: 0;
    }

    .dialog::backdrop {
      background: rgba(5, 6, 9, .7);
      backdrop-filter: blur(4px);
    }

    .dialog-shell {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr);
      gap: 0;
      min-height: 70vh;
    }

    .dialog-preview {
      background: #0f1116;
      border-right: 1px solid var(--line);
      display: grid;
      min-height: 70vh;
    }

    .dialog-preview iframe, .dialog-preview img {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: #0f1116;
    }

    .dialog-content {
      padding: 18px;
      display: grid;
      gap: 16px;
      align-content: start;
    }

    .dialog-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: start;
    }

    .dialog-head h2 {
      margin: 0 0 6px;
      font-size: 1.15rem;
    }

    .dialog-head p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }

    .close {
      border: 1px solid var(--line);
      background: #101218;
      color: var(--text);
      width: 36px;
      height: 36px;
      border-radius: 999px;
      cursor: pointer;
    }

    .section {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px;
      background: rgba(16, 18, 24, .72);
      display: grid;
      gap: 12px;
    }

    .section h3 {
      margin: 0;
      font-size: .98rem;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .annotation-list {
      display: grid;
      gap: 10px;
    }

    .annotation-item {
      display: grid;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      background: #12141a;
    }

    .annotation-item header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: .82rem;
    }

    .annotation-item p {
      margin: 0;
      line-height: 1.5;
    }

    .annotation-item button {
      justify-self: start;
    }

    .metro {
      position: fixed;
      right: 16px;
      bottom: 64px;
      z-index: 40;
      width: min(280px, calc(100vw - 32px));
      border: 1px solid var(--line);
      background: rgba(21, 23, 29, .92);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 14px;
      display: none;
      gap: 10px;
    }

    body.metro-open .metro {
      display: grid;
    }

    .metro-fab {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 41;
      min-height: 40px;
      padding: 0 14px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(21, 23, 29, .96);
      color: var(--text);
      box-shadow: var(--shadow);
      cursor: pointer;
      font-weight: 700;
    }

    .metro-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }

    .metro-head strong {
      font-size: .95rem;
    }

    .metro-flash {
      display: grid;
      place-items: center;
      height: 90px;
      border-radius: 12px;
      border: 1px solid rgba(124, 77, 255, .2);
      background: radial-gradient(circle at center, rgba(124, 77, 255, .2), rgba(124, 77, 255, .05) 62%, rgba(0, 0, 0, .12) 100%);
      transition: transform .06s ease, background .12s ease, box-shadow .12s ease;
    }

    .metro-flash.active {
      transform: scale(1.02);
      background: radial-gradient(circle at center, rgba(121, 217, 155, .95), rgba(121, 217, 155, .25) 48%, rgba(124, 77, 255, .05) 100%);
      box-shadow: 0 0 0 8px rgba(121, 217, 155, .12);
    }

    .metro-ic {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .22);
      box-shadow: 0 0 0 0 rgba(121, 217, 155, 0);
    }

    .metro-flash.active .metro-ic {
      background: white;
    }

    .metro-controls {
      display: grid;
      grid-template-columns: 84px 1fr 1fr;
      gap: 8px;
    }

    .metro-controls input, .metro-controls button {
      min-height: 40px;
    }

    .metro-status {
      color: var(--muted);
      font-size: .82rem;
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }

    @media (max-width: 980px) {
      .hero-card { height: 200px; }
      .resource-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .browse-tools {
        grid-template-columns: minmax(0, 1fr) auto;
      }
      .browse-tools .search-control { grid-column: 1 / -1; }
      .browse-tools .view-toggle { grid-column: 1; }
      .browse-tools .sort-control { grid-column: 2; }
      .tab, .action, .primary, .secondary { min-height: 44px; }
      .dialog-shell { grid-template-columns: 1fr; }
      .dialog-preview { min-height: 46vh; border-right: 0; border-bottom: 1px solid var(--line); }
    }

    @media (max-width: 640px) {
      .shell {
        width: min(100vw - 16px, 1180px);
        padding: max(8px, env(safe-area-inset-top)) 0 max(24px, env(safe-area-inset-bottom));
      }
      .topbar { margin-bottom: 10px; }
      .hero-card { height: 150px; }
      .controls { padding: 8px; gap: 8px; }
      .library-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
      .library-title { grid-column: 1; grid-row: 1; }
      .library-head .tabs {
        grid-column: 1 / -1;
        grid-row: 2;
        width: 100%;
        margin: 0;
        padding: 0 0 2px;
        scroll-padding-inline: 0;
      }
      .library-actions { grid-column: 2; grid-row: 1; }
      .browse-tools {
        grid-template-columns: 1fr auto;
        gap: 8px;
      }
      .browse-tools .search-control { grid-column: 1 / -1; grid-row: 1; }
      .browse-tools .view-toggle { grid-column: 1; grid-row: 2; }
      .browse-tools .sort-control { grid-column: 2; grid-row: 2; }
      .browse-tools .sort-control span { position: absolute; width: 1px; height: 1px; overflow: hidden; }
      .browse-tools select { min-height: 44px; }
      .tab, .action { min-height: 44px; }
      .resource-grid { padding: 10px; grid-template-columns: 1fr; }
      .resource-grid.list-view { padding: 4px 8px 10px; }
      .grid-2 { grid-template-columns: 1fr; }
      .metro,
      .metro-fab {
        right: 10px;
      }

      .metro {
        left: 10px;
        bottom: 62px;
        width: auto;
      }

      .metro-fab {
        bottom: 10px;
      }

      .resource-grid.list-view .card {
        grid-template-columns: minmax(110px, 1fr) auto;
        gap: 2px 8px;
        min-height: 46px;
        padding: 4px 6px;
        align-items: center;
      }
      .resource-grid.list-view .card h3 { line-height: 1.15; }
      .resource-grid.list-view .meta { grid-column: 1; }
      .resource-grid.list-view .actions {
        grid-column: 2;
        grid-row: 1 / span 2;
      }
      .resource-grid.list-view .actions .action:not(:first-child) {
        display: none;
      }
      .resource-grid.list-view .action { min-height: 36px; padding: 5px 10px; }
      .user-row { grid-template-columns: 1fr; }
      .user-actions { justify-content: start; }

      body[data-authenticated="0"] #actionsDialog {
        width: calc(100vw - 16px);
        max-height: calc(100dvh - 16px - env(safe-area-inset-bottom));
        margin: auto 8px max(8px, env(safe-area-inset-bottom));
        border-radius: 14px 14px 10px 10px;
      }

      body[data-authenticated="0"] #actionsDialog .upload-panel {
        padding: 16px;
      }

      body[data-authenticated="0"] #actionsDialog .upload-logo {
        width: 48px;
        height: 48px;
      }

      body[data-authenticated="0"] #loginForm .primary {
        width: 100%;
      }
    }
  </style>
</head>
<body data-authenticated="${authenticated ? "1" : "0"}" data-approved="${approved ? "1" : "0"}" data-role="${escapeHtmlText(role)}">
  <main class="shell">
    <header class="topbar">
      <div class="hero-card">
        <img src="/assets/banner.png" alt="" aria-hidden="true">
      </div>
    </header>

    <section class="layout">
      <section class="panel library">
        <div class="controls">
          <div class="library-head">
            <div class="library-title">
              <h1>Sheet library</h1>
              <span class="sheet-count"><strong id="totalCount">0</strong> sheets</span>
            </div>
            <div class="tabs" id="tabs" aria-label="Sheet type filter">
              <button class="tab active" data-tab="all" type="button">All</button>
              <button class="tab" data-tab="pdf" type="button">PDFs</button>
              <button class="tab" data-tab="image" type="button">Images</button>
              <button class="tab" data-tab="chart" type="button">Charts</button>
              <button class="tab" data-tab="other" type="button">Other</button>
            </div>
            <div class="library-actions">
              <button class="primary auth-only requires-approved" id="addSheetButton" type="button">Add sheet</button>
              <button class="secondary" id="accountButton" type="button"
                onclick="document.querySelector('#actionsDialog').showModal()">${
                  authenticated ? "Account" : "Sign in"
                }</button>
            </div>
          </div>
          <div class="browse-tools">
            <div class="view-toggle" id="viewToggle" aria-label="Library view toggle">
              <button class="tab active" data-view="grid" type="button">Grid</button>
              <button class="tab" data-view="list" type="button">List</button>
              <button class="tab auth-only" id="myUploadsButton" type="button">My uploads</button>
            </div>
            <label class="search-control">
              Search sheets
              <input id="searchInput" type="search" placeholder="Title, artist, tags, key, notes, or text">
            </label>
            <label class="sort-control">
              <span>Sort by</span>
              <select id="sortSelect">
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="title-asc">Title A–Z</option>
                <option value="title-desc">Title Z–A</option>
              </select>
            </label>
          </div>
        </div>
        <div class="resource-grid" id="resourceGrid" aria-live="polite" aria-busy="true"></div>
      </section>
    </section>

    <dialog class="actions-dialog" id="actionsDialog" aria-labelledby="actionsTitle">
      <aside class="panel upload-panel">
        <div class="panel-title">
          <img class="upload-logo" src="/assets/logo.png" alt="">
          <div>
            <h2 id="actionsTitle">${authenticated ? "Library actions" : "Sign in"}</h2>
            <p class="panel-subtitle" id="actionsSubtitle">Upload, account, and thumbnail maintenance live here.</p>
          </div>
          <span class="pill" id="authBadge">${authenticated ? `Signed in as ${escapeHtmlText(username || "account")}` : "Signed out"}</span>
          <button class="close" id="closeActions" type="button" aria-label="Close library actions">✕</button>
        </div>

        <div class="tabs" id="sideTabs">
          <button class="tab ${authenticated ? "active" : ""}" data-side-tab="add" type="button">Add sheet</button>
          <button class="tab ${authenticated ? "" : "active"}" data-side-tab="admin" type="button">Account</button>
        </div>

        <div class="tab-panels">
          <section class="tab-panel ${authenticated ? "active" : ""}" data-side-panel="add">
            <form id="uploadForm" class="requires-approved">
              <label>
                Title
                <input id="titleInput" name="title" maxlength="120" required placeholder="Example: Holy Holy Holy">
              </label>

              <label>
                Artist / source
                <input id="artistInput" name="artist" maxlength="120" placeholder="Example: Traditional">
              </label>

              <label>
                Sheet type
                <select id="kindInput" name="kind" required>
                  <option value="pdf">PDF sheets</option>
                  <option value="image">Images</option>
                  <option value="chart">Chord charts</option>
                </select>
              </label>

              <div class="grid-2">
                <label>
                  Key
                  <input id="keyInput" name="key" maxlength="24" placeholder="Example: G">
                </label>
                <label>
                  Capo
                  <input id="capoInput" name="capo" type="number" min="0" max="24" step="1" placeholder="0">
                </label>
              </div>

              <label>
                BPM
                <input id="bpmInput" name="bpm" type="number" min="20" max="400" step="1" placeholder="120">
              </label>

              <label>
                Tags
                <input id="tagsInput" name="tags" maxlength="300" placeholder="Example: mass, practice, Wednesday, favorites">
              </label>

              <label>
                Notes
                <textarea id="notesInput" name="notes" maxlength="2500" placeholder="Any notes, reminders, or performance cues"></textarea>
              </label>

              <label>
                Files
                <input id="fileInput" name="files" type="file" multiple required>
              </label>

              <p class="hint" id="typeHint"></p>
              <button class="primary" id="uploadButton" type="submit">Upload</button>
              <div class="message" id="message" role="status" aria-live="polite"></div>
            </form>
            <div class="admin-meta guest-only">
              <strong>Sign in required</strong>
              <span>Sign in to upload sheets. Administrative maintenance remains restricted to administrators.</span>
            </div>
          </section>

          <section class="tab-panel ${authenticated ? "" : "active"}" data-side-panel="admin">
            <div class="admin-stack guest-only">
              <div class="admin-stack" id="signInView">
                <p class="signin-intro">Sign in to browse and upload.</p>
                <form id="loginForm">
                  <label>Username
                    <input id="loginUserInput" name="username" autocomplete="username" required>
                  </label>
                  <label>Password
                    <input id="loginPasswordInput" name="password" type="password" autocomplete="current-password" required>
                  </label>
                  <button class="primary" id="loginButton" type="submit">Sign in</button>
                  <div class="message" id="loginMessage" role="status" aria-live="polite"></div>
                </form>
                <button class="secondary" id="showRegisterButton" type="button">Create an account</button>
              </div>
              <div class="admin-stack" id="registerView" hidden>
                <div class="admin-meta">
                  <strong>Create an account</strong>
                  <span>Registration provides guest-library access until an administrator approves membership.</span>
                </div>
                <form id="registerForm">
                  <label>Username
                    <input id="registerLogin" maxlength="128" autocomplete="username" required>
                  </label>
                  <label>Display name
                    <input id="registerDisplayName" maxlength="120" required>
                  </label>
                  <label>Password
                    <input id="registerPassword" type="password" autocomplete="new-password" required>
                  </label>
                  <button class="primary" id="registerButton" type="submit">Create account</button>
                  <div class="message" id="registerMessage" role="status" aria-live="polite"></div>
                </form>
                <button class="secondary" id="showSignInButton" type="button">Back to sign in</button>
              </div>
            </div>

            <div class="admin-stack auth-only">
              <div class="admin-meta">
                <strong id="adminUserLabel">Admin</strong>
                <span id="adminSessionLabel">Signed in.</span>
              </div>
              <div class="admin-meta" id="pendingApprovalNotice" ${approved || role === "admin" ? "hidden" : ""}>
                <strong>Awaiting administrator approval</strong>
                <span>You can use the guest library and manage your account. Uploads and annotations unlock after approval.</span>
              </div>
              <form id="profileForm">
                <label>Display name
                  <input id="profileDisplayName" maxlength="120" required>
                </label>
                <label>Current password
                  <input id="profileCurrentPassword" type="password" autocomplete="current-password" required>
                </label>
                <button class="secondary" id="profileSaveButton" type="submit">Save profile</button>
                <div class="message" id="profileMessage" role="status" aria-live="polite"></div>
              </form>
              <div class="admin-actions admin-only">
                <button class="secondary" id="refreshThumbsButton" type="button">Refresh thumbnails</button>
                <a class="secondary backup-link" href="/api/admin/uploads-backup.zip">Back up uploaded files</a>
              </div>
              <section class="user-management admin-only" id="userManagement">
                <h3>Accounts</h3>
                <form id="createUserForm">
                  <div class="grid-2">
                    <label>Username
                      <input id="newUserLogin" maxlength="128" autocomplete="off" required>
                    </label>
                    <label>Display name
                      <input id="newUserDisplayName" maxlength="120" autocomplete="off" required>
                    </label>
                  </div>
                  <div class="grid-2">
                    <label>Temporary password
                      <input id="newUserPassword" type="password" autocomplete="new-password" required>
                    </label>
                    <label>Role
                      <select id="newUserRole">
                        <option value="member">Member</option>
                        <option value="admin">Administrator</option>
                      </select>
                    </label>
                  </div>
                  <label><span><input id="newUserMustChange" type="checkbox" checked> Require password change at first login</span></label>
                  <button class="primary" id="createUserButton" type="submit">Create account</button>
                </form>
                <div class="message" id="userMessage" role="status" aria-live="polite"></div>
                <div class="user-list" id="userList"></div>
              </section>
              <button class="secondary danger" id="logoutButton" type="button">Sign out</button>
              <div class="message" id="adminMessage" role="status" aria-live="polite"></div>
            </div>
          </section>
        </div>
      </aside>
    </dialog>
  </main>

  <dialog class="dialog" id="sheetDialog">
    <div class="dialog-shell">
      <div class="dialog-preview" id="detailPreview"></div>
      <div class="dialog-content">
        <div class="dialog-head">
          <div>
            <h2 id="detailTitle">Sheet</h2>
            <p id="detailSubtitle"></p>
          </div>
          <button class="close" id="closeDialog" type="button">✕</button>
        </div>

        <section class="section">
          <h3>Edit metadata</h3>
          <form id="detailForm">
            <label>
              Title
              <input id="detailTitleInput" name="title" maxlength="120" required>
            </label>
            <label>
              Artist / source
              <input id="detailArtistInput" name="artist" maxlength="120">
            </label>
            <div class="grid-2">
              <label>
                Key
                <input id="detailKeyInput" name="key" maxlength="24">
              </label>
              <label>
                Capo
                <input id="detailCapoInput" name="capo" type="number" min="0" max="24" step="1">
              </label>
            </div>
            <label>
              BPM
              <input id="detailBpmInput" name="bpm" type="number" min="20" max="400" step="1">
            </label>
            <label>
              Tags
              <input id="detailTagsInput" name="tags" maxlength="300" placeholder="Comma-separated tags">
            </label>
            <label>
              Notes
              <textarea id="detailNotesInput" name="notes" maxlength="2500"></textarea>
            </label>
            <button class="primary" id="detailSaveButton" type="submit">Save changes</button>
            <button class="secondary danger admin-only" id="detailDeleteButton" type="button">Delete sheet</button>
            <button class="secondary admin-only" id="detailVisibilityButton" type="button">Publish to guest library</button>
            <div class="message" id="detailMessage" role="status" aria-live="polite"></div>
          </form>
        </section>

        <section class="section">
          <h3>Page-based annotations</h3>
          <form id="annotationForm" class="requires-approved">
            <div class="grid-2">
              <label>
                Page
                <input id="annotationPageInput" name="page" type="number" min="1" step="1" required placeholder="1">
              </label>
              <label>
                Color
                <select id="annotationColorInput" name="color">
                  <option value="amber">Amber</option>
                  <option value="green">Green</option>
                  <option value="blue">Blue</option>
                  <option value="pink">Pink</option>
                </select>
              </label>
            </div>
            <label>
              Note
              <textarea id="annotationTextInput" name="text" maxlength="500" required placeholder="Example: repeat the refrain here"></textarea>
            </label>
            <button class="secondary" id="annotationAddButton" type="submit">Add annotation</button>
          </form>
          <div class="annotation-list" id="annotationList"></div>
        </section>
      </div>
    </div>
  </dialog>

  <dialog class="actions-dialog" id="passwordChangeDialog"
    aria-labelledby="passwordChangeTitle" aria-describedby="passwordChangeHelp">
    <aside class="panel upload-panel">
      <h2 id="passwordChangeTitle">Change temporary password</h2>
      <p id="passwordChangeHelp">You must choose a new password before using the library.</p>
      <form id="passwordChangeForm">
        <label>Current password
          <input id="currentPasswordInput" type="password" autocomplete="current-password" required>
        </label>
        <label>New password
          <input id="newPasswordInput" type="password" autocomplete="new-password" required>
        </label>
        <label>Confirm new password
          <input id="confirmPasswordInput" type="password" autocomplete="new-password" required>
        </label>
        <div class="message" id="passwordChangeMessage" role="alert" aria-live="assertive"></div>
        <button class="primary" id="passwordChangeButton" type="submit">Change password</button>
        <button class="secondary" id="passwordChangeLogout" type="button">Sign out</button>
      </form>
    </aside>
  </dialog>

  <dialog class="actions-dialog" id="accountActionDialog" aria-labelledby="accountActionTitle">
    <aside class="panel upload-panel">
      <h2 id="accountActionTitle">Update account</h2>
      <p id="accountActionHelp" class="panel-subtitle"></p>
      <form id="accountActionForm">
        <div id="accountIdentityFields">
          <label>Username
            <input id="accountEditLogin" maxlength="128">
          </label>
          <label>Display name
            <input id="accountEditDisplayName" maxlength="120">
          </label>
        </div>
        <div id="accountPasswordFields">
          <label>Temporary password
            <input id="accountResetPassword" type="password" autocomplete="new-password">
          </label>
          <p class="hint">The user will be required to change this password at next login.</p>
        </div>
        <div class="message" id="accountActionMessage" role="status" aria-live="polite"></div>
        <button class="primary" id="accountActionConfirm" type="submit">Confirm</button>
        <button class="secondary" id="accountActionCancel" type="button">Cancel</button>
      </form>
    </aside>
  </dialog>

  <button class="metro-fab" id="metroFab" type="button" aria-controls="metroPanel" aria-expanded="false">Metronome</button>

  <aside class="metro" id="metroPanel" aria-label="Visual metronome">
    <div class="metro-head">
      <strong>Visual metronome</strong>
      <span class="pill" id="metroStatus">Stopped</span>
    </div>
    <div class="metro-flash" id="metroFlash"><div class="metro-ic"></div></div>
    <div class="metro-controls">
      <input id="metroBpm" type="number" min="20" max="400" step="1" value="120" aria-label="Metronome BPM">
      <button class="secondary" id="metroTap" type="button">Tap</button>
      <button class="primary" id="metroToggle" type="button">Start</button>
    </div>
    <div class="metro-status">
      <span id="metroBeatLabel">Beat 0</span>
      <span>Visual only</span>
    </div>
  </aside>

  <script>
    const state = {
      resources: [],
      total: 0,
      activeTab: "all",
      viewMode: "grid",
      sort: "newest",
      mineOnly: false,
      query: "",
      catalogStatus: "loading",
      catalogMessage: "",
      selectedResource: null,
      selectedResourceId: ""
    };
    const authState = ${JSON.stringify({
      authenticated,
      csrfToken,
      username: username || "",
      displayName: displayName || "",
      userId: userId || "",
      role: role || "",
      approved: Boolean(approved),
      mustChangePassword: Boolean(mustChangePassword)
    })};

    const kindLabels = {
      pdf: "PDF",
      image: "Image",
      chart: "Chart",
      other: "Other"
    };

    const kindAccept = {
      pdf: ".pdf",
      image: ".png,.jpg,.jpeg",
      chart: ".txt,.md,.docx"
    };

    const uploadForm = document.querySelector("#uploadForm");
    const passwordChangeDialog = document.querySelector("#passwordChangeDialog");
    const passwordChangeForm = document.querySelector("#passwordChangeForm");
    const currentPasswordInput = document.querySelector("#currentPasswordInput");
    const newPasswordInput = document.querySelector("#newPasswordInput");
    const confirmPasswordInput = document.querySelector("#confirmPasswordInput");
    const passwordChangeMessage = document.querySelector("#passwordChangeMessage");
    const passwordChangeButton = document.querySelector("#passwordChangeButton");
    const passwordChangeLogout = document.querySelector("#passwordChangeLogout");
    const actionsDialog = document.querySelector("#actionsDialog");
    const addSheetButton = document.querySelector("#addSheetButton");
    const accountButton = document.querySelector("#accountButton");
    const closeActions = document.querySelector("#closeActions");
    const titleInput = document.querySelector("#titleInput");
    const artistInput = document.querySelector("#artistInput");
    const kindInput = document.querySelector("#kindInput");
    const keyInput = document.querySelector("#keyInput");
    const capoInput = document.querySelector("#capoInput");
    const bpmInput = document.querySelector("#bpmInput");
    const tagsInput = document.querySelector("#tagsInput");
    const notesInput = document.querySelector("#notesInput");
    const fileInput = document.querySelector("#fileInput");
    const typeHint = document.querySelector("#typeHint");
    const message = document.querySelector("#message");
    const uploadButton = document.querySelector("#uploadButton");
    const sideTabs = document.querySelector("#sideTabs");
    const authBadge = document.querySelector("#authBadge");
    const actionsTitle = document.querySelector("#actionsTitle");
    const loginForm = document.querySelector("#loginForm");
    const loginUserInput = document.querySelector("#loginUserInput");
    const loginPasswordInput = document.querySelector("#loginPasswordInput");
    const loginButton = document.querySelector("#loginButton");
    const loginMessage = document.querySelector("#loginMessage");
    const registerForm = document.querySelector("#registerForm");
    const registerLogin = document.querySelector("#registerLogin");
    const registerDisplayName = document.querySelector("#registerDisplayName");
    const registerPassword = document.querySelector("#registerPassword");
    const registerButton = document.querySelector("#registerButton");
    const registerMessage = document.querySelector("#registerMessage");
    const signInView = document.querySelector("#signInView");
    const registerView = document.querySelector("#registerView");
    const showRegisterButton = document.querySelector("#showRegisterButton");
    const showSignInButton = document.querySelector("#showSignInButton");
    const adminUserLabel = document.querySelector("#adminUserLabel");
    const adminSessionLabel = document.querySelector("#adminSessionLabel");
    const refreshThumbsButton = document.querySelector("#refreshThumbsButton");
    const logoutButton = document.querySelector("#logoutButton");
    const adminMessage = document.querySelector("#adminMessage");
    const resourceGrid = document.querySelector("#resourceGrid");
    const searchInput = document.querySelector("#searchInput");
    const sortSelect = document.querySelector("#sortSelect");
    const totalCount = document.querySelector("#totalCount");
    const tabs = document.querySelector("#tabs");
    const viewToggle = document.querySelector("#viewToggle");
    const myUploadsButton = document.querySelector("#myUploadsButton");
    const profileForm = document.querySelector("#profileForm");
    const profileDisplayName = document.querySelector("#profileDisplayName");
    const profileCurrentPassword = document.querySelector("#profileCurrentPassword");
    const profileSaveButton = document.querySelector("#profileSaveButton");
    const profileMessage = document.querySelector("#profileMessage");
    const createUserForm = document.querySelector("#createUserForm");
    const newUserLogin = document.querySelector("#newUserLogin");
    const newUserDisplayName = document.querySelector("#newUserDisplayName");
    const newUserPassword = document.querySelector("#newUserPassword");
    const newUserRole = document.querySelector("#newUserRole");
    const newUserMustChange = document.querySelector("#newUserMustChange");
    const createUserButton = document.querySelector("#createUserButton");
    const userMessage = document.querySelector("#userMessage");
    const userList = document.querySelector("#userList");
    const accountActionDialog = document.querySelector("#accountActionDialog");
    const accountActionTitle = document.querySelector("#accountActionTitle");
    const accountActionHelp = document.querySelector("#accountActionHelp");
    const accountActionForm = document.querySelector("#accountActionForm");
    const accountIdentityFields = document.querySelector("#accountIdentityFields");
    const accountPasswordFields = document.querySelector("#accountPasswordFields");
    const accountEditLogin = document.querySelector("#accountEditLogin");
    const accountEditDisplayName = document.querySelector("#accountEditDisplayName");
    const accountResetPassword = document.querySelector("#accountResetPassword");
    const accountActionMessage = document.querySelector("#accountActionMessage");
    const accountActionConfirm = document.querySelector("#accountActionConfirm");
    const accountActionCancel = document.querySelector("#accountActionCancel");
    const metroFab = document.querySelector("#metroFab");
    const sheetDialog = document.querySelector("#sheetDialog");
    const detailPreview = document.querySelector("#detailPreview");
    const detailTitle = document.querySelector("#detailTitle");
    const detailSubtitle = document.querySelector("#detailSubtitle");
    const detailForm = document.querySelector("#detailForm");
    const detailTitleInput = document.querySelector("#detailTitleInput");
    const detailArtistInput = document.querySelector("#detailArtistInput");
    const detailKeyInput = document.querySelector("#detailKeyInput");
    const detailCapoInput = document.querySelector("#detailCapoInput");
    const detailBpmInput = document.querySelector("#detailBpmInput");
    const detailTagsInput = document.querySelector("#detailTagsInput");
    const detailNotesInput = document.querySelector("#detailNotesInput");
    const detailMessage = document.querySelector("#detailMessage");
    const detailDeleteButton = document.querySelector("#detailDeleteButton");
    const detailVisibilityButton = document.querySelector("#detailVisibilityButton");
    const closeDialog = document.querySelector("#closeDialog");
    const annotationForm = document.querySelector("#annotationForm");
    const annotationPageInput = document.querySelector("#annotationPageInput");
    const annotationTextInput = document.querySelector("#annotationTextInput");
    const annotationColorInput = document.querySelector("#annotationColorInput");
    const annotationList = document.querySelector("#annotationList");
    const metroFlash = document.querySelector("#metroFlash");
    const metroBpm = document.querySelector("#metroBpm");
    const metroTap = document.querySelector("#metroTap");
    const metroToggle = document.querySelector("#metroToggle");
    const metroStatus = document.querySelector("#metroStatus");
    const metroBeatLabel = document.querySelector("#metroBeatLabel");

    const metroState = {
      running: false,
      beat: 0,
      timer: null,
      tapAt: 0
    };

    let activeDetailId = "";
    let catalogRequest = 0;
    let pendingAccountAction = null;

    function setMessage(text, kind = "") {
      message.textContent = text;
      message.className = "message" + (kind ? " " + kind : "");
    }

    function setDetailMessage(text, kind = "") {
      detailMessage.textContent = text;
      detailMessage.className = "message" + (kind ? " " + kind : "");
    }

    function formatBytes(bytes) {
      if (!bytes) return "0 B";
      const units = ["B", "KB", "MB", "GB"];
      const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      return (bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1) + " " + units[index];
    }

    function formatDate(value) {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric"
      }).format(new Date(value));
    }

    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"']/g, function(char) {
        return ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        })[char];
      });
    }

    function splitTags(value) {
      return String(value || "")
        .split(",")
        .map(function(tag) { return tag.trim(); })
        .filter(Boolean)
        .slice(0, 24);
    }

    function formatTags(tags) {
      if (!Array.isArray(tags) || !tags.length) {
        return "";
      }

      return tags.map(function(tag) {
        return '<span class="chip">' + escapeHtml(tag) + '</span>';
      }).join("");
    }

    function setAuthUi(nextState) {
      authState.authenticated = Boolean(nextState && nextState.authenticated);
      authState.csrfToken = nextState && nextState.csrfToken ? String(nextState.csrfToken) : "";
      authState.username = nextState && (nextState.user || nextState.username)
        ? String(nextState.user || nextState.username) : "";
      authState.displayName = nextState && nextState.displayName
        ? String(nextState.displayName) : authState.displayName || "";
      authState.userId = nextState && nextState.userId ? String(nextState.userId) : "";
      authState.role = nextState && nextState.role ? String(nextState.role) : "";
      authState.approved = Boolean(nextState && nextState.approved);
      authState.mustChangePassword = Boolean(nextState && nextState.mustChangePassword);
      document.body.dataset.authenticated = authState.authenticated ? "1" : "0";
      document.body.dataset.role = authState.role;
      document.body.dataset.approved = authState.approved ? "1" : "0";
      authBadge.textContent = authState.authenticated
        ? "Signed in as " + (authState.username || "admin")
        : "Signed out";
      actionsTitle.textContent = authState.authenticated ? "Library actions" : "Sign in";
      accountButton.textContent = authState.authenticated
        ? "Account"
        : "Sign in";
      adminUserLabel.textContent = authState.authenticated
        ? (authState.username || "admin")
        : "Admin";
      adminSessionLabel.textContent = authState.authenticated
        ? (authState.role === "admin" || authState.approved
          ? "Approved account." : "Awaiting administrator approval.")
        : "Signed out.";
      document.querySelector("#pendingApprovalNotice").hidden =
        !authState.authenticated || authState.role === "admin" || authState.approved;
      profileDisplayName.value = authState.displayName;
      if (authState.authenticated) {
        loginForm.reset();
        loginMessage.textContent = "";
        adminMessage.textContent = "";
      }
    }

    function requirePasswordChange() {
      if (!authState.authenticated || !authState.mustChangePassword) return;
      if (actionsDialog.open) actionsDialog.close();
      if (sheetDialog.open) sheetDialog.close();
      if (!passwordChangeDialog.open) passwordChangeDialog.showModal();
      window.setTimeout(function() { currentPasswordInput.focus(); }, 0);
    }

    function currentSideTab() {
      return sideTabs.querySelector(".tab.active")?.dataset.sideTab || "add";
    }

    function setSideTab(tabName) {
      sideTabs.querySelectorAll("[data-side-tab]").forEach(function(button) {
        button.classList.toggle("active", button.dataset.sideTab === tabName);
      });
      document.querySelectorAll("[data-side-panel]").forEach(function(panel) {
        panel.classList.toggle("active", panel.dataset.sidePanel === tabName);
      });
    }

    async function apiFetch(url, options = {}) {
      const headers = new Headers(options.headers || {});
      if (options.method && options.method !== "GET" && authState.csrfToken) {
        headers.set("X-CSRF-Token", authState.csrfToken);
      }

      const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        headers
      });

      if (response.status === 401 && url !== "/api/auth/login") {
        setAuthUi({ authenticated: false, csrfToken: "", user: "", userId: "", role: "" });
        setSideTab("admin");
        if (!actionsDialog.open) actionsDialog.showModal();
        loginMessage.textContent = "Your session expired. Sign in to continue; unsaved form values were kept.";
        loginMessage.className = "message error";
        passwordChangeForm.reset();
        if (passwordChangeDialog.open) passwordChangeDialog.close();
      }
      return response;
    }

    function updateFileAccept() {
      const accept = kindAccept[kindInput.value] || "";
      fileInput.accept = accept;
      typeHint.textContent = "Allowed for " + kindLabels[kindInput.value] + ": " + accept;
    }

    function getQueryParams() {
      return new URLSearchParams({
        kind: state.activeTab,
        q: state.query,
        sort: state.sort,
        mine: state.mineOnly ? "1" : ""
      });
    }

    function persistBrowseState(push = false) {
      const url = new URL(window.location.href);
      if (state.activeTab === "all") url.searchParams.delete("kind");
      else url.searchParams.set("kind", state.activeTab);
      if (state.query) url.searchParams.set("q", state.query);
      else url.searchParams.delete("q");
      url.searchParams.set("view", state.viewMode);
      if (state.sort === "newest") url.searchParams.delete("sort");
      else url.searchParams.set("sort", state.sort);
      if (state.mineOnly) url.searchParams.set("mine", "1");
      else url.searchParams.delete("mine");
      history[push ? "pushState" : "replaceState"]({
        kind: state.activeTab,
        q: state.query,
        view: state.viewMode,
        sort: state.sort,
        mine: state.mineOnly,
        scrollY: window.scrollY
      }, "", url);
      sessionStorage.setItem("mafusheets.scrollY", String(window.scrollY));
    }

    async function loadResources() {
      const request = ++catalogRequest;
      state.catalogStatus = "loading";
      state.catalogMessage = "";
      render();
      try {
        const response = await apiFetch("/api/resources?" + getQueryParams().toString());
        let result = {};
        try { result = await response.json(); } catch {}
        if (request !== catalogRequest) return;
        if (!response.ok) {
          if (response.status === 401) {
            state.catalogStatus = "authentication";
            state.catalogMessage = "Sign in to browse the library.";
          } else if (response.status === 403) {
            state.catalogStatus = "authorization";
            state.catalogMessage = "You do not have permission to browse this library.";
          } else {
            state.catalogStatus = "error";
            state.catalogMessage = result.error || "The catalog is temporarily unavailable.";
          }
          render();
          return;
        }
        state.resources = Array.isArray(result.resources) ? result.resources : [];
        state.total = Number(result.total) || 0;
        state.catalogStatus = "ready";
        render();
      } catch {
        if (request !== catalogRequest) return;
        state.catalogStatus = "network";
        state.catalogMessage = "The library could not be reached. Check your connection and retry.";
        render();
      }
    }

    function render() {
      totalCount.textContent = state.total;
      resourceGrid.classList.toggle("list-view", state.viewMode === "list");
      resourceGrid.setAttribute("aria-busy", state.catalogStatus === "loading" ? "true" : "false");

      if (state.catalogStatus === "loading") {
        resourceGrid.innerHTML = '<div class="library-state">Loading library…</div>';
        return;
      }
      if (state.catalogStatus !== "ready") {
        const canRetry = state.catalogStatus === "error" || state.catalogStatus === "network";
        resourceGrid.innerHTML = '<div class="library-state error"><strong>' +
          escapeHtml(state.catalogMessage || "Library unavailable.") + '</strong>' +
          (canRetry ? '<br><button class="action" data-retry-catalog type="button">Retry</button>' : '') +
          '</div>';
        return;
      }
      if (!state.resources.length) {
        const filtered = Boolean(state.query || state.activeTab !== "all" || state.mineOnly);
        resourceGrid.innerHTML = '<div class="library-state">' +
          (filtered ? "No sheets match these filters." : "The library is empty.") + '</div>';
        return;
      }

      resourceGrid.innerHTML = state.resources.map(function(resource) {
        const thumbnailStatus = resource.thumbnailStatus || (resource.thumbnail && resource.thumbnail.status) || "";
        const thumbnailReady = resource.thumbnailUrl && (!thumbnailStatus || thumbnailStatus === "ready");
        const placeholderLabel = thumbnailStatus === "pending" || thumbnailStatus === "processing"
          ? "Thumbnail processing"
          : thumbnailStatus === "failed" || thumbnailStatus === "unavailable" || thumbnailStatus === "stale"
            ? "Thumbnail unavailable"
            : (kindLabels[resource.sheetKind] || resource.extension.replace(".", "")).toUpperCase();
        const preview = thumbnailReady
          ? '<img class="' + (resource.sheetKind === "pdf" ? "pdf-thumb" : resource.sheetKind === "image" ? "image-thumb" : "") + '" src="' + resource.thumbnailUrl + '" alt="" data-thumbnail>'
          : '<div class="thumbnail-placeholder">' + escapeHtml(placeholderLabel) + '</div>';
        const previewWrap = state.viewMode === "list" ? "" :
          (resource.sheetKind === "pdf" && resource.readerUrl
            ? '<a class="preview" href="' + resource.readerUrl + '">' + preview + '</a>'
            : '<button class="preview" type="button" data-open="' + resource.id + '">' + preview + '</button>');
        const openAction = resource.sheetKind === "pdf" && resource.readerUrl
          ? '<a class="action" href="' + resource.readerUrl + '">Open</a>'
          : '<button class="action" type="button" data-open="' + resource.id + '">Open</button>';
        const previewAction = resource.canPreview
          ? '<a class="action" href="' + resource.viewUrl + '" target="_blank" rel="noopener">Preview</a>'
          : '';
        const artist = resource.artist ? '<span>' + escapeHtml(resource.artist) + '</span>' : '';
        const metaBits = [];
        if (resource.key) metaBits.push('Key ' + escapeHtml(resource.key));
        if (resource.capo !== null && resource.capo !== undefined && resource.capo !== '') metaBits.push('Capo ' + escapeHtml(resource.capo));
        if (resource.bpm !== null && resource.bpm !== undefined && resource.bpm !== '') metaBits.push(escapeHtml(resource.bpm) + ' BPM');
        metaBits.push(formatDate(resource.uploadedAt));

        return '<article class="card" data-resource-id="' + resource.id + '">' +
          previewWrap +
          '<div class="card-body">' +
            '<h3>' + escapeHtml(resource.title) + '</h3>' +
            '<div class="meta">' +
              artist +
              '<span>' + escapeHtml(metaBits.join(' · ')) + '</span>' +
              '<span>' + escapeHtml(resource.originalName) + ' · ' + formatBytes(resource.size) + '</span>' +
              '<span>' + escapeHtml((kindLabels[resource.sheetKind] || 'Other')) + ' · ' + escapeHtml(String(resource.annotationsCount || 0)) + ' annotations</span>' +
            '</div>' +
            '<div class="chips">' + formatTags(resource.tags) + '</div>' +
            '<div class="actions">' +
              openAction +
              previewAction +
              '<a class="action" href="' + resource.downloadUrl + '">Download</a>' +
            '</div>' +
          '</div>' +
        '</article>';
      }).join("");
    }

    function debounce(fn, delay) {
      let timer;
      return function() {
        const args = arguments;
        clearTimeout(timer);
        timer = setTimeout(function() {
          fn.apply(null, args);
        }, delay);
      };
    }

    const debouncedLoadResources = debounce(loadResources, 220);

    async function openSheet(id) {
      activeDetailId = id;
      setDetailMessage("");
      const response = await fetch('/api/resources/' + encodeURIComponent(id));
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Could not load sheet.');
      }

      const resource = result.resource;
      state.selectedResource = resource;
      state.selectedResourceId = resource.id;

      detailTitle.textContent = resource.title || 'Sheet';
      detailSubtitle.textContent = [
        resource.artist,
        kindLabels[resource.sheetKind] || 'Other',
        resource.originalName,
        resource.uploadedByDisplayName ? "Uploaded by " + resource.uploadedByDisplayName : ""
      ].filter(Boolean).join(' · ');
      detailTitleInput.value = resource.title || '';
      detailArtistInput.value = resource.artist || '';
      detailKeyInput.value = resource.key || '';
      detailCapoInput.value = resource.capo === null || resource.capo === undefined ? '' : resource.capo;
      detailBpmInput.value = resource.bpm === null || resource.bpm === undefined ? '' : resource.bpm;
      detailTagsInput.value = Array.isArray(resource.tags) ? resource.tags.join(', ') : '';
      detailNotesInput.value = resource.notes || '';
      annotationPageInput.value = '';
      annotationTextInput.value = '';
      annotationColorInput.value = 'amber';
      const canEdit = authState.role === "admin" || resource.uploadedBy === authState.userId;
      Array.from(detailForm.elements).forEach(function(control) {
        if (control !== detailDeleteButton) control.disabled = !canEdit;
      });
      detailDeleteButton.hidden = authState.role !== "admin";
      detailVisibilityButton.hidden = authState.role !== "admin";
      detailVisibilityButton.textContent = resource.visibility === "guest"
        ? "Remove from guest library" : "Publish to guest library";

      if (resource.canPreview) {
        if (resource.sheetKind === 'image') {
          const status = resource.thumbnailStatus || (resource.thumbnail && resource.thumbnail.status) || "";
          if (resource.thumbnailUrl && (!status || status === "ready")) {
            detailPreview.innerHTML = '<img class="image-thumb" src="' + resource.thumbnailUrl + '" alt="" data-thumbnail>';
          } else {
            detailPreview.innerHTML = '<div class="thumbnail-placeholder">Thumbnail unavailable. Use Preview or Download.</div>';
          }
        } else {
          detailPreview.innerHTML = '<iframe src="' + (resource.readerUrl || resource.viewUrl) + '"></iframe>';
        }
      } else {
        detailPreview.innerHTML = '<div class="empty">Preview not available for this file type. Use download instead.</div>';
      }

      renderAnnotations(resource.annotations || []);
      sheetDialog.showModal();
    }

    function renderAnnotations(annotations) {
      if (!annotations.length) {
        annotationList.innerHTML = '<div class="empty">No annotations yet.</div>';
        return;
      }

      const sorted = annotations.slice().sort(function(a, b) {
        return (a.page - b.page) || new Date(a.createdAt) - new Date(b.createdAt);
      });

      annotationList.innerHTML = sorted.map(function(annotation) {
        return '<article class="annotation-item">' +
          '<header><span>Page ' + escapeHtml(annotation.page) + '</span><span>' + escapeHtml(annotation.color || 'amber') + '</span></header>' +
          '<p>' + escapeHtml(annotation.text) + '</p>' +
          '<button class="action" type="button" data-delete-annotation="' + annotation.id + '">Delete</button>' +
        '</article>';
      }).join('');
    }

    async function saveDetails(event) {
      event.preventDefault();
      if (!activeDetailId) return;

      setDetailMessage('Saving changes...');
      document.querySelector("#detailSaveButton").disabled = true;
      const body = {
        title: detailTitleInput.value,
        artist: detailArtistInput.value,
        key: detailKeyInput.value,
        capo: detailCapoInput.value,
        bpm: detailBpmInput.value,
        tags: splitTags(detailTagsInput.value),
        notes: detailNotesInput.value
      };

      try {
        const response = await apiFetch('/api/resources/' + encodeURIComponent(activeDetailId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok) {
          const prefix = response.status === 400 ? "Check the entered values: " :
            response.status === 401 ? "Sign in again: " :
            response.status === 403 ? "Not authorized: " : "Could not save yet: ";
          throw new Error(prefix + (result.error || 'Could not save changes.'));
        }
        setDetailMessage('Saved.', 'ok');
        state.selectedResource = result.resource;
        await loadResources();
      } finally {
        document.querySelector("#detailSaveButton").disabled = false;
      }
    }

    async function addAnnotation(event) {
      event.preventDefault();
      if (!activeDetailId) return;

      const body = {
        page: annotationPageInput.value,
        text: annotationTextInput.value,
        color: annotationColorInput.value
      };

      const response = await apiFetch('/api/resources/' + encodeURIComponent(activeDetailId) + '/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Could not save annotation.');
      }

      annotationPageInput.value = '';
      annotationTextInput.value = '';
      annotationColorInput.value = 'amber';
      setDetailMessage('Annotation saved.', 'ok');
      await loadResources();
      await openSheet(activeDetailId);
    }

    async function deleteAnnotation(annotationId) {
      if (!activeDetailId) return;

      const response = await apiFetch('/api/resources/' + encodeURIComponent(activeDetailId) + '/annotations/' + encodeURIComponent(annotationId), {
        method: 'DELETE'
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Could not delete annotation.');
      }

      await loadResources();
      await openSheet(activeDetailId);
    }

    async function deleteResource() {
      if (!activeDetailId || authState.role !== "admin") return;
      if (!window.confirm("Delete this sheet? Its source and thumbnail will be quarantined before cleanup.")) return;

      setDetailMessage("Deleting sheet...");
      detailDeleteButton.disabled = true;
      try {
        const response = await apiFetch('/api/resources/' + encodeURIComponent(activeDetailId), {
          method: 'DELETE'
        });
        const result = await response.json();
        if (!response.ok) {
          const prefix = response.status === 403 ? "Administrator access is required. " :
            response.status >= 500 ? "Deletion or cleanup did not complete. The sheet remains visible. " : "";
          throw new Error(prefix + (result.error || 'Could not delete sheet.'));
        }
        setDetailMessage('Sheet deleted.', 'ok');
        sheetDialog.close();
        await loadResources();
      } finally {
        detailDeleteButton.disabled = false;
      }
    }

    async function changeResourceVisibility() {
      const resource = state.selectedResource;
      if (!resource || authState.role !== "admin") return;

      const visibility = resource.visibility === "guest" ? "restricted" : "guest";
      detailVisibilityButton.disabled = true;
      try {
        const response = await apiFetch(
          "/api/admin/resources/" + encodeURIComponent(resource.id) + "/visibility",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ visibility: visibility })
          }
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not change visibility.");

        resource.visibility = result.visibility;
        detailVisibilityButton.textContent = result.visibility === "guest"
          ? "Remove from guest library" : "Publish to guest library";
        setDetailMessage(result.visibility === "guest"
          ? "Published to the guest library." : "Restricted to approved members.", "ok");
        await loadResources();
      } catch (error) {
        setDetailMessage(error.message, "error");
      } finally {
        detailVisibilityButton.disabled = false;
      }
    }

    async function login(event) {
      event.preventDefault();
      loginMessage.textContent = "Signing in...";
      loginMessage.className = "message";
      loginButton.disabled = true;

      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: loginUserInput.value,
            password: loginPasswordInput.value
          })
        });
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || "Could not sign in.");
        }

        setAuthUi({
          authenticated: true,
          csrfToken: result.csrfToken,
          user: result.user,
          displayName: result.displayName,
          userId: result.userId,
          role: result.role,
          mustChangePassword: result.mustChangePassword
        });
        if (result.mustChangePassword) {
          requirePasswordChange();
          return;
        }
        loginMessage.textContent = "Signed in.";
        loginMessage.className = "message ok";
        setSideTab("add");
        await loadResources();
      } catch (error) {
        loginMessage.textContent = error.message;
        loginMessage.className = "message error";
      } finally {
        loginButton.disabled = false;
      }
    }

    async function logout() {
      adminMessage.textContent = "Signing out...";
      adminMessage.className = "message";

      try {
        const response = await apiFetch("/api/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" }
        });
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || "Could not sign out.");
        }

        setAuthUi({
          authenticated: false,
          csrfToken: "",
          user: ""
        });
        passwordChangeForm.reset();
        if (passwordChangeDialog.open) passwordChangeDialog.close();
        adminMessage.textContent = "Signed out.";
        adminMessage.className = "message ok";
        setSideTab("admin");
      } catch (error) {
        adminMessage.textContent = error.message;
        adminMessage.className = "message error";
      }
    }

    async function registerAccount(event) {
      event.preventDefault();
      registerButton.disabled = true;
      registerMessage.textContent = "Creating account…";
      registerMessage.className = "message";
      try {
        const response = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            loginIdentifier: registerLogin.value,
            displayName: registerDisplayName.value,
            password: registerPassword.value
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not create account.");
        setAuthUi({ authenticated: true, ...result });
        registerForm.reset();
        registerMessage.textContent = "Account created. Approval is pending.";
        registerMessage.className = "message ok";
        await loadResources();
      } catch (error) {
        registerMessage.textContent = error.message;
        registerMessage.className = "message error";
      } finally {
        registerButton.disabled = false;
      }
    }

    async function changeRequiredPassword(event) {
      event.preventDefault();
      passwordChangeMessage.className = "message";
      if (newPasswordInput.value !== confirmPasswordInput.value) {
        passwordChangeMessage.textContent = "New password confirmation does not match.";
        passwordChangeMessage.className = "message error";
        return;
      }
      passwordChangeButton.disabled = true;
      try {
        const response = await apiFetch("/api/auth/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentPassword: currentPasswordInput.value,
            newPassword: newPasswordInput.value
          })
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || (response.status === 401
            ? "Your session expired. Sign in again." : "Password validation failed."));
        }
        authState.csrfToken = result.csrfToken;
        authState.mustChangePassword = false;
        passwordChangeForm.reset();
        passwordChangeDialog.close();
        await loadResources();
      } catch (error) {
        passwordChangeMessage.textContent = error.message;
        passwordChangeMessage.className = "message error";
      } finally {
        passwordChangeButton.disabled = false;
      }
    }

    async function refreshThumbnails() {
      if (!authState.authenticated) {
        adminMessage.textContent = "Sign in first.";
        adminMessage.className = "message error";
        return;
      }

      adminMessage.textContent = "Refreshing thumbnails...";
      adminMessage.className = "message";
      refreshThumbsButton.disabled = true;

      try {
        const response = await apiFetch("/api/admin/thumbnails/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true })
        });
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || "Could not refresh thumbnails.");
        }

        adminMessage.textContent = "Refreshed " + String(result.refreshed || 0) + " thumbnails.";
        adminMessage.className = "message ok";
        await loadResources();
      } catch (error) {
        adminMessage.textContent = error.message;
        adminMessage.className = "message error";
      } finally {
        refreshThumbsButton.disabled = false;
      }
    }

    function renderUsers(users) {
      if (!users.length) {
        userList.innerHTML = '<div class="hint">No accounts found.</div>';
        return;
      }
      userList.innerHTML = users.map(function(user) {
        const status = !user.enabled ? "Suspended" : user.approved ? "Approved" : "Pending approval";
        const lastLogin = user.lastLoginAt ? "Last login " + formatDate(user.lastLoginAt) : "Never signed in";
        const isSelf = user.id === authState.userId;
        return '<div class="user-row" data-user-id="' + escapeHtml(user.id) + '">' +
          '<span hidden data-user-login>' + escapeHtml(user.loginIdentifier) + '</span>' +
          '<span hidden data-user-display-name>' + escapeHtml(user.displayName) + '</span>' +
          '<div><strong>' + escapeHtml(user.displayName) + '</strong><div>' +
          escapeHtml(user.loginIdentifier) + '</div><p class="hint">' +
          escapeHtml(user.role === "admin" ? "Administrator" : "Member") + " · " +
          status + " · " + escapeHtml(lastLogin) +
          (user.mustChangePassword ? " · Password change required" : "") + '</p></div>' +
          '<div class="user-actions">' +
          '<button class="secondary" type="button" data-user-action="edit">Edit</button>' +
          (isSelf ? '<span class="hint">Current account</span>' :
          '<button class="secondary" type="button" data-user-action="role" data-role="' +
          escapeHtml(user.role) + '">' + (user.role === "admin" ? "Make member" : "Make admin") + '</button>' +
          (user.role === "admin" ? "" :
          '<button class="secondary" type="button" data-user-action="approval" data-approved="' +
          String(user.approved) + '">' + (user.approved ? "Revoke approval" : "Approve") + '</button>') +
          '<button class="secondary" type="button" data-user-action="toggle" data-enabled="' +
          String(user.enabled) + '">' + (user.enabled ? "Disable" : "Enable") + '</button>' +
          '<button class="secondary" type="button" data-user-action="reset">Reset password</button>') +
          '</div></div>';
      }).join("");
    }

    async function loadUsers() {
      if (authState.role !== "admin") return;
      userMessage.textContent = "Loading accounts…";
      userMessage.className = "message";
      const response = await apiFetch("/api/admin/users");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load accounts.");
      renderUsers(Array.isArray(result.users) ? result.users : []);
      userMessage.textContent = "";
    }

    async function createUser(event) {
      event.preventDefault();
      createUserButton.disabled = true;
      userMessage.textContent = "Creating account…";
      userMessage.className = "message";
      try {
        const response = await apiFetch("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            loginIdentifier: newUserLogin.value,
            displayName: newUserDisplayName.value,
            password: newUserPassword.value,
            role: newUserRole.value,
            mustChangePassword: newUserMustChange.checked
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not create account.");
        createUserForm.reset();
        newUserRole.value = "member";
        newUserMustChange.checked = true;
        userMessage.textContent = "Account created.";
        userMessage.className = "message ok";
        await loadUsers();
      } catch (error) {
        userMessage.textContent = error.message;
        userMessage.className = "message error";
      } finally {
        createUserButton.disabled = false;
      }
    }

    function openAccountAction(button) {
      const row = button.closest("[data-user-id]");
      if (!row) return;
      const action = button.dataset.userAction;
      pendingAccountAction = {
        id: row.dataset.userId,
        action: action,
        role: button.dataset.role,
        enabled: button.dataset.enabled,
        approved: button.dataset.approved
      };
      accountActionForm.reset();
      accountActionMessage.textContent = "";
      accountIdentityFields.hidden = action !== "edit";
      accountPasswordFields.hidden = action !== "reset";
      if (action === "edit") {
        accountActionTitle.textContent = "Edit account";
        accountActionHelp.textContent = "Update the login identifier or display name.";
        accountEditLogin.value = row.querySelector("[data-user-login]").textContent;
        accountEditDisplayName.value = row.querySelector("[data-user-display-name]").textContent;
        accountActionConfirm.textContent = "Save account";
      } else if (action === "reset") {
        accountActionTitle.textContent = "Reset password";
        accountActionHelp.textContent = "Set a temporary password and revoke the user’s active sessions.";
        accountActionConfirm.textContent = "Reset password";
      } else if (action === "role") {
        accountActionTitle.textContent = button.dataset.role === "admin"
          ? "Make this user a member?" : "Make this user an administrator?";
        accountActionHelp.textContent = "This changes the account’s permissions and revokes active sessions.";
        accountActionConfirm.textContent = "Confirm role change";
      } else if (action === "approval") {
        accountActionTitle.textContent = button.dataset.approved === "true"
          ? "Revoke this member’s approval?" : "Approve this member?";
        accountActionHelp.textContent = button.dataset.approved === "true"
          ? "The member will be signed out and limited to the guest library."
          : "The member will be able to access restricted documents, upload, and annotate.";
        accountActionConfirm.textContent = button.dataset.approved === "true"
          ? "Revoke approval" : "Approve member";
      } else {
        accountActionTitle.textContent = button.dataset.enabled === "true"
          ? "Disable this account?" : "Enable this account?";
        accountActionHelp.textContent = button.dataset.enabled === "true"
          ? "The user will be signed out and unable to log in."
          : "The user will be allowed to log in again.";
        accountActionConfirm.textContent = button.dataset.enabled === "true" ? "Disable account" : "Enable account";
      }
      accountActionDialog.showModal();
    }

    async function submitAccountAction(event) {
      event.preventDefault();
      if (!pendingAccountAction) return;
      const action = pendingAccountAction.action;
      let url = "/api/admin/users/" + encodeURIComponent(pendingAccountAction.id);
      let method = "PATCH";
      let body;
      if (action === "role") {
        body = { role: pendingAccountAction.role === "admin" ? "member" : "admin" };
      } else if (action === "approval") {
        body = { approved: pendingAccountAction.approved !== "true" };
      } else if (action === "toggle") {
        body = { enabled: pendingAccountAction.enabled !== "true" };
      } else if (action === "reset") {
        url += "/reset-password";
        method = "POST";
        body = { password: accountResetPassword.value, mustChangePassword: true };
      } else if (action === "edit") {
        body = {
          loginIdentifier: accountEditLogin.value,
          displayName: accountEditDisplayName.value
        };
      } else {
        return;
      }
      accountActionConfirm.disabled = true;
      accountActionMessage.textContent = "Updating account…";
      try {
        const response = await apiFetch(url, {
          method: method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not update account.");
        userMessage.textContent = action === "reset" ? "Temporary password set." : "Account updated.";
        userMessage.className = "message ok";
        if (pendingAccountAction.id === authState.userId && action === "edit") {
          authState.username = result.user.loginIdentifier;
          authState.displayName = result.user.displayName;
          setAuthUi(authState);
        }
        accountActionDialog.close();
        pendingAccountAction = null;
        await loadUsers();
      } catch (error) {
        accountActionMessage.textContent = error.message;
        accountActionMessage.className = "message error";
      } finally {
        accountActionConfirm.disabled = false;
      }
    }

    async function saveProfile(event) {
      event.preventDefault();
      profileSaveButton.disabled = true;
      profileMessage.textContent = "Saving profile…";
      profileMessage.className = "message";
      try {
        const response = await apiFetch("/api/account/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: profileDisplayName.value,
            currentPassword: profileCurrentPassword.value
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not save profile.");
        authState.displayName = result.user.displayName;
        profileCurrentPassword.value = "";
        setAuthUi(authState);
        profileMessage.textContent = "Profile saved.";
        profileMessage.className = "message ok";
      } catch (error) {
        profileMessage.textContent = error.message;
        profileMessage.className = "message error";
      } finally {
        profileSaveButton.disabled = false;
      }
    }

    function updateMetroUi() {
      metroStatus.textContent = metroState.running ? 'Running' : 'Stopped';
      metroToggle.textContent = metroState.running ? 'Stop' : 'Start';
      metroBeatLabel.textContent = 'Beat ' + metroState.beat;
      metroFlash.classList.toggle('active', metroState.running);
    }

    function flashBeat() {
      metroFlash.classList.add('active');
      window.clearTimeout(metroFlash._flashTimer);
      metroFlash._flashTimer = window.setTimeout(function() {
        if (!metroState.running) return;
        metroFlash.classList.remove('active');
      }, 120);
    }

    function startMetronome() {
      stopMetronome();
      const bpm = Math.max(20, Math.min(400, Number.parseInt(metroBpm.value || '120', 10) || 120));
      const interval = 60000 / bpm;
      metroState.running = true;
      metroState.beat = 0;
      updateMetroUi();
      flashBeat();
      metroState.timer = window.setInterval(function() {
        metroState.beat = metroState.beat % 4 + 1;
        updateMetroUi();
        flashBeat();
      }, interval);
      localStorage.setItem('mafusheets.metroBpm', String(bpm));
    }

    function stopMetronome() {
      if (metroState.timer) {
        window.clearInterval(metroState.timer);
        metroState.timer = null;
      }
      metroState.running = false;
      metroState.beat = 0;
      updateMetroUi();
    }

    function tapTempo() {
      const now = Date.now();
      if (metroState.tapAt) {
        const diff = now - metroState.tapAt;
        if (diff >= 250 && diff <= 3000) {
          const bpm = Math.round(60000 / diff);
          metroBpm.value = String(Math.max(20, Math.min(400, bpm)));
          localStorage.setItem('mafusheets.metroBpm', metroBpm.value);
        }
      }
      metroState.tapAt = now;
    }

    function initMetro() {
      const stored = localStorage.getItem('mafusheets.metroBpm');
      if (stored) {
        metroBpm.value = stored;
      }
      updateMetroUi();
    }

    function setViewMode(viewMode) {
      state.viewMode = viewMode === "list" ? "list" : "grid";
      viewToggle.querySelectorAll("[data-view]").forEach(function(button) {
        button.classList.toggle("active", button.dataset.view === state.viewMode);
      });
      localStorage.setItem("mafusheets.viewMode", state.viewMode);
      persistBrowseState();
      render();
    }

    kindInput.addEventListener('change', updateFileAccept);
    sideTabs.addEventListener('click', function(event) {
      const button = event.target.closest('[data-side-tab]');
      if (!button) return;

      setSideTab(button.dataset.sideTab);
    });
    searchInput.addEventListener('input', function() {
      state.query = searchInput.value;
      persistBrowseState();
      debouncedLoadResources();
    });

    sortSelect.addEventListener("change", function() {
      state.sort = sortSelect.value;
      localStorage.setItem("mafusheets.sort", state.sort);
      persistBrowseState(true);
      loadResources();
    });

    myUploadsButton.addEventListener("click", function() {
      state.mineOnly = !state.mineOnly;
      myUploadsButton.classList.toggle("active", state.mineOnly);
      persistBrowseState(true);
      loadResources();
    });

    tabs.addEventListener('click', function(event) {
      const button = event.target.closest('[data-tab]');
      if (!button) return;

      state.activeTab = button.dataset.tab;
      tabs.querySelectorAll('.tab').forEach(function(tab) {
        tab.classList.toggle('active', tab === button);
      });
      persistBrowseState(true);
      loadResources();
    });

    viewToggle.addEventListener("click", function(event) {
      const button = event.target.closest("[data-view]");
      if (!button) return;
      setViewMode(button.dataset.view);
    });

    resourceGrid.addEventListener('click', function(event) {
      if (event.target.closest('[data-retry-catalog]')) {
        loadResources();
        return;
      }
      const button = event.target.closest('[data-open]');
      if (!button) return;
      openSheet(button.dataset.open).catch(function(error) {
        setMessage(error.message, 'error');
      });
    });

    resourceGrid.addEventListener('error', function(event) {
      const image = event.target.closest && event.target.closest('img[data-thumbnail]');
      if (!image) return;
      const placeholder = document.createElement("div");
      placeholder.className = "thumbnail-placeholder";
      placeholder.textContent = "Thumbnail unavailable";
      image.replaceWith(placeholder);
    }, true);

    detailPreview.addEventListener('error', function(event) {
      if (!event.target.matches('img[data-thumbnail]')) return;
      detailPreview.innerHTML = '<div class="thumbnail-placeholder">Thumbnail unavailable. Use Preview or Download.</div>';
    }, true);

    detailForm.addEventListener('submit', function(event) {
      saveDetails(event).catch(function(error) {
        setDetailMessage(error.message, 'error');
      });
    });

    annotationForm.addEventListener('submit', function(event) {
      addAnnotation(event).catch(function(error) {
        setDetailMessage(error.message, 'error');
      });
    });

    annotationList.addEventListener('click', function(event) {
      const button = event.target.closest('[data-delete-annotation]');
      if (!button) return;
      deleteAnnotation(button.dataset.deleteAnnotation).catch(function(error) {
        setDetailMessage(error.message, 'error');
      });
    });

    detailDeleteButton.addEventListener('click', function() {
      deleteResource().catch(function(error) {
        setDetailMessage(error.message, 'error');
      });
    });
    detailVisibilityButton.addEventListener("click", changeResourceVisibility);

    loginForm.addEventListener('submit', function(event) {
      login(event).catch(function(error) {
        loginMessage.textContent = error.message;
        loginMessage.className = "message error";
      });
    });

    refreshThumbsButton.addEventListener('click', function() {
      refreshThumbnails().catch(function(error) {
        adminMessage.textContent = error.message;
        adminMessage.className = "message error";
      });
    });

    createUserForm.addEventListener("submit", function(event) {
      createUser(event);
    });
    registerForm.addEventListener("submit", registerAccount);
    showRegisterButton.addEventListener("click", function() {
      signInView.hidden = true;
      registerView.hidden = false;
      actionsTitle.textContent = "Create an account";
      registerLogin.focus();
    });
    showSignInButton.addEventListener("click", function() {
      registerView.hidden = true;
      signInView.hidden = false;
      actionsTitle.textContent = "Sign in";
      loginUserInput.focus();
    });
    userList.addEventListener("click", function(event) {
      const button = event.target.closest("[data-user-action]");
      if (!button) return;
      openAccountAction(button);
    });
    profileForm.addEventListener("submit", saveProfile);
    accountActionForm.addEventListener("submit", submitAccountAction);
    accountActionCancel.addEventListener("click", function() {
      pendingAccountAction = null;
      accountActionDialog.close();
    });

    logoutButton.addEventListener('click', function() {
      logout().catch(function(error) {
        adminMessage.textContent = error.message;
        adminMessage.className = "message error";
      });
    });
    passwordChangeForm.addEventListener("submit", function(event) {
      changeRequiredPassword(event).catch(function(error) {
        passwordChangeMessage.textContent = error.message;
        passwordChangeMessage.className = "message error";
      });
    });
    passwordChangeLogout.addEventListener("click", function() {
      logout().catch(function(error) {
        passwordChangeMessage.textContent = error.message;
        passwordChangeMessage.className = "message error";
      });
    });
    passwordChangeDialog.addEventListener("cancel", function(event) {
      if (authState.mustChangePassword) event.preventDefault();
    });

    closeDialog.addEventListener('click', function() {
      sheetDialog.close();
    });

    function openActions(tabName) {
      setSideTab(tabName);
      if (!actionsDialog.open) actionsDialog.showModal();
      if (tabName === "admin" && authState.role === "admin") {
        loadUsers().catch(function(error) {
          userMessage.textContent = error.message;
          userMessage.className = "message error";
        });
      }
      window.setTimeout(function() {
        const target = tabName === "add" ? titleInput : loginUserInput;
        if (target && target.offsetParent !== null) target.focus();
      }, 0);
    }

    addSheetButton.addEventListener("click", function() { openActions("add"); });
    accountButton.addEventListener("click", function() { openActions("admin"); });
    closeActions.addEventListener("click", function() { actionsDialog.close(); });
    actionsDialog.addEventListener("click", function(event) {
      if (event.target === actionsDialog) actionsDialog.close();
    });

    sheetDialog.addEventListener('click', function(event) {
      const rect = sheetDialog.getBoundingClientRect();
      const clickedInDialog = rect.top <= event.clientY && event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX && event.clientX <= rect.left + rect.width;
      if (!clickedInDialog) {
        sheetDialog.close();
      }
    });

    uploadForm.addEventListener('submit', async function(event) {
      event.preventDefault();
      if (!authState.authenticated) {
        setMessage('Sign in from Admin before uploading.', 'error');
        setSideTab('admin');
        return;
      }
      setMessage('');
      uploadButton.disabled = true;
      uploadButton.textContent = 'Uploading...';
      const selectedFiles = Array.from(fileInput.files).map(function(file) { return file.name; });
      setMessage("Uploading " + String(selectedFiles.length) + " file(s)…");

      const body = new FormData();
      body.append('title', titleInput.value);
      body.append('artist', artistInput.value);
      body.append('kind', kindInput.value);
      body.append('key', keyInput.value);
      body.append('capo', capoInput.value);
      body.append('bpm', bpmInput.value);
      body.append('tags', tagsInput.value);
      body.append('notes', notesInput.value);
      for (const file of fileInput.files) {
        body.append('files', file);
      }

      try {
        const response = await apiFetch('/api/upload', {
          method: 'POST',
          body: body
        });
        const result = await response.json();

        if (!response.ok) {
          const names = selectedFiles.length ? " Selected files: " + selectedFiles.join(", ") + "." : "";
          const prefix = response.status === 400 || response.status === 413 || response.status === 429
            ? "Upload rejected. " : response.status === 403
              ? "You are not authorized to upload. " : "Upload failed before completion. ";
          throw new Error(prefix + (result.error || 'Please retry.') + names);
        }

        uploadForm.reset();
        kindInput.value = 'pdf';
        updateFileAccept();
        setMessage('Upload accepted. Search and thumbnail processing may continue in the background.', 'ok');
        await loadResources();
      } catch (error) {
        setMessage(error.message, 'error');
      } finally {
        uploadButton.disabled = false;
        uploadButton.textContent = 'Upload';
      }
    });

    metroToggle.addEventListener('click', function() {
      if (metroState.running) {
        stopMetronome();
      } else {
        startMetronome();
      }
    });

    metroTap.addEventListener('click', tapTempo);
    metroBpm.addEventListener('change', function() {
      localStorage.setItem('mafusheets.metroBpm', metroBpm.value);
      if (metroState.running) {
        startMetronome();
      }
    });

    metroFab.addEventListener("click", function() {
      const open = document.body.classList.toggle("metro-open");
      metroFab.setAttribute("aria-expanded", open ? "true" : "false");
      metroFab.textContent = open ? "Close metronome" : "Metronome";
    });

    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape' && sheetDialog.open) {
        sheetDialog.close();
      }
    });

    window.addEventListener("scroll", function() {
      sessionStorage.setItem("mafusheets.scrollY", String(window.scrollY));
      const current = history.state || {};
      history.replaceState({ ...current, scrollY: window.scrollY }, "", window.location.href);
    }, { passive: true });

    window.addEventListener("popstate", function(event) {
      const params = new URLSearchParams(window.location.search);
      state.activeTab = params.get("kind") || "all";
      state.query = params.get("q") || "";
      state.viewMode = params.get("view") === "list" ? "list" : "grid";
      state.sort = ["oldest", "title-asc", "title-desc"].includes(params.get("sort"))
        ? params.get("sort") : "newest";
      state.mineOnly = params.get("mine") === "1";
      searchInput.value = state.query;
      sortSelect.value = state.sort;
      myUploadsButton.classList.toggle("active", state.mineOnly);
      tabs.querySelectorAll("[data-tab]").forEach(function(tab) {
        tab.classList.toggle("active", tab.dataset.tab === state.activeTab);
      });
      setViewMode(state.viewMode);
      loadResources().then(function() {
        const targetScroll = event.state && Number(event.state.scrollY);
        if (Number.isFinite(targetScroll)) window.scrollTo(0, targetScroll);
      });
    });

    const initialParams = new URLSearchParams(window.location.search);
    state.activeTab = initialParams.get("kind") || "all";
    state.query = initialParams.get("q") || "";
    state.mineOnly = initialParams.get("mine") === "1";
    const initialSort = initialParams.get("sort") || localStorage.getItem("mafusheets.sort") || "newest";
    state.sort = ["newest", "oldest", "title-asc", "title-desc"].includes(initialSort)
      ? initialSort : "newest";
    searchInput.value = state.query;
    sortSelect.value = state.sort;
    myUploadsButton.classList.toggle("active", state.mineOnly);
    tabs.querySelectorAll("[data-tab]").forEach(function(tab) {
      tab.classList.toggle("active", tab.dataset.tab === state.activeTab);
    });
    setAuthUi(authState);
    setSideTab(authState.authenticated ? "add" : "admin");
    updateFileAccept();
    setViewMode(initialParams.get("view") || localStorage.getItem("mafusheets.viewMode") || "grid");
    initMetro();
    requirePasswordChange();
    loadResources().then(function() {
      const savedScroll = Number(sessionStorage.getItem("mafusheets.scrollY") || "0");
      if (savedScroll > 0) window.scrollTo(0, savedScroll);
    });
  </script>
</body>
</html>`;
}

ensureStorage()
  .then(() => {
    const server = app.listen(PORT, HOST, () => {
      console.log(`MafuSheets running on http://${HOST}:${PORT}`);
    });
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = Math.min(60000, REQUEST_TIMEOUT_MS);
  })
  .catch((error) => {
    safeLogError("storage startup failed", error);
    process.exit(1);
  });
