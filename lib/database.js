"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const BetterSqlite3 = require("better-sqlite3");

const CURRENT_SCHEMA_VERSION = 6;
const MIGRATION_ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const MIGRATION_ACTOR_NAME = "Legacy catalog migration";
const EMERGENCY_ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const EMERGENCY_ACTOR_NAME = "Emergency local account operator";
const LEGACY_IMPORT_KEY = "legacy_json_import";

const SCHEMA_V1 = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login_identifier TEXT UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  CHECK (
    (is_system = 1 AND login_identifier IS NULL AND password_hash IS NULL AND enabled = 0)
    OR
    (is_system = 0 AND login_identifier IS NOT NULL AND password_hash IS NOT NULL)
  )
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  musical_key TEXT NOT NULL DEFAULT '',
  capo INTEGER CHECK (capo IS NULL OR (capo >= 0 AND capo <= 24)),
  bpm INTEGER CHECK (bpm IS NULL OR (bpm >= 20 AND bpm <= 400)),
  notes TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  sheet_kind TEXT NOT NULL CHECK (sheet_kind IN ('pdf', 'image', 'chart', 'other')),
  search_text TEXT NOT NULL DEFAULT '',
  search_status TEXT NOT NULL DEFAULT 'empty',
  indexed_at TEXT,
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE resource_files (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  category TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  extension TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (resource_id, ordinal),
  UNIQUE (category, stored_name)
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  page INTEGER NOT NULL CHECK (page >= 1 AND page <= 9999),
  text TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'amber',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json))
);

CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX resources_uploaded_by_idx ON resources(uploaded_by);
CREATE INDEX resource_files_resource_idx ON resource_files(resource_id);
CREATE INDEX annotations_resource_idx ON annotations(resource_id);
CREATE INDEX annotations_user_idx ON annotations(user_id);
CREATE INDEX audit_events_occurred_idx ON audit_events(occurred_at);
`;

const SCHEMA_V2 = `
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);
`;

const SCHEMA_V3 = `
CREATE TABLE pending_operations (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (
    operation_type IN ('upload', 'replacement', 'deletion', 'thumbnail', 'cleanup')
  ),
  resource_id TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'quarantined', 'failed', 'completed')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  error_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pending_operations_status_idx ON pending_operations(status);
CREATE INDEX pending_operations_resource_idx ON pending_operations(resource_id);

CREATE TABLE operation_locks (
  lock_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX operation_locks_expires_idx ON operation_locks(expires_at);
`;

const SCHEMA_V4 = `
CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  job_type TEXT NOT NULL CHECK (job_type IN ('index_thumbnail')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  error_text TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX processing_jobs_status_idx ON processing_jobs(status, created_at);
CREATE INDEX processing_jobs_resource_idx ON processing_jobs(resource_id);
CREATE INDEX processing_jobs_actor_idx ON processing_jobs(actor_user_id, created_at);
CREATE UNIQUE INDEX processing_jobs_active_resource_idx ON processing_jobs(resource_id)
WHERE status IN ('queued', 'running');

CREATE TABLE upload_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  occurred_at TEXT NOT NULL
);
CREATE INDEX upload_usage_user_time_idx ON upload_usage(user_id, occurred_at);
`;

const SCHEMA_V6 = `
ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1));
ALTER TABLE users ADD COLUMN approved_at TEXT;
ALTER TABLE users ADD COLUMN approved_by TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE resources ADD COLUMN visibility TEXT NOT NULL DEFAULT 'restricted'
  CHECK (visibility IN ('guest', 'restricted'));
CREATE INDEX resources_visibility_idx ON resources(visibility, deleted_at);
`;

function nowIso() {
  return new Date().toISOString();
}

function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new BetterSqlite3(databasePath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  applySchemaMigrations(db);
  return db;
}

function applySchemaMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)
  );
  if (!applied.has(1)) {
    db.transaction(() => {
      db.exec(SCHEMA_V1);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(1, "identity and resource foundation", nowIso());
    })();
  }
  if (!applied.has(2)) {
    db.transaction(() => {
      db.exec(SCHEMA_V2);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(2, "persistent server sessions", nowIso());
    })();
  }
  if (!applied.has(3)) {
    if (applied.size > 0) {
      const backupPath = `${db.name}.pre-migration-v3-${Date.now()}.sqlite`;
      db.prepare("VACUUM INTO ?").run(backupPath);
      fs.chmodSync(backupPath, 0o400);
    }
    db.transaction(() => {
      db.exec(SCHEMA_V3);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(3, "recoverable resource operations and scoped locks", nowIso());
    })();
  }
  if (!applied.has(4)) {
    if (applied.size > 0) {
      const backupPath = `${db.name}.pre-migration-v4-${Date.now()}.sqlite`;
      db.prepare("VACUUM INTO ?").run(backupPath);
      fs.chmodSync(backupPath, 0o400);
    }
    db.transaction(() => {
      db.exec(SCHEMA_V4);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(4, "bounded attributable processing jobs", nowIso());
    })();
  }
  if (!applied.has(5)) {
    db.transaction(() => {
      const timestamp = nowIso();
      db.prepare(`
        INSERT OR IGNORE INTO users
          (id, login_identifier, display_name, password_hash, role, enabled,
           must_change_password, is_system, created_at, updated_at)
        VALUES (?, NULL, ?, NULL, 'admin', 0, 0, 1, ?, ?)
      `).run(EMERGENCY_ACTOR_ID, EMERGENCY_ACTOR_NAME, timestamp, timestamp);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(5, "stable emergency CLI audit actor", timestamp);
    })();
  }
  if (!applied.has(6)) {
    if (applied.size > 0) {
      const backupPath = `${db.name}.pre-migration-v6-${Date.now()}.sqlite`;
      db.prepare("VACUUM INTO ?").run(backupPath);
      fs.chmodSync(backupPath, 0o400);
    }
    db.transaction(() => {
      const timestamp = nowIso();
      db.exec(SCHEMA_V6);
      db.prepare(`
        UPDATE users SET approved=1, approved_at=created_at
        WHERE is_system=0
      `).run();
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(6, "account approval and resource visibility", timestamp);
    })();
  }
  const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported database schema version: ${version}`);
  }
  if (db.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error("SQLite foreign-key enforcement could not be enabled.");
  }
}

function cleanLegacyString(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`Legacy resource ${field} is required.`);
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`Legacy resource ${field} must be a string.`);
  }
  const cleaned = value.trim();
  if (required && !cleaned) {
    throw new Error(`Legacy resource ${field} is required.`);
  }
  return cleaned;
}

function validIso(value, field) {
  const raw = cleanLegacyString(value, field, { required: true });
  if (!Number.isFinite(Date.parse(raw))) {
    throw new Error(`Legacy resource ${field} must be a valid timestamp.`);
  }
  return new Date(raw).toISOString();
}

function kindForExtension(extension) {
  if (extension === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg"].includes(extension)) return "image";
  if ([".txt", ".md", ".docx"].includes(extension)) return "chart";
  return "other";
}

function validateLegacyCatalog(value) {
  if (!Array.isArray(value)) {
    throw new Error("Legacy catalog root must be a JSON array.");
  }
  const ids = new Set();
  const paths = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Legacy resource at index ${index} must be an object.`);
    }
    const id = cleanLegacyString(item.id, "id", { required: true });
    const category = cleanLegacyString(item.category, "category", { required: true });
    const storedName = cleanLegacyString(item.storedName, "storedName", { required: true });
    const originalName = cleanLegacyString(item.originalName, "originalName", { required: true });
    const extension = cleanLegacyString(item.extension, "extension", { required: true }).toLowerCase();
    const title = cleanLegacyString(item.title, "title", { required: true });
    if (ids.has(id)) throw new Error(`Duplicate legacy resource ID: ${id}`);
    ids.add(id);
    const relativePath = `${category}/${storedName}`;
    if (paths.has(relativePath)) throw new Error(`Conflicting legacy file path: ${relativePath}`);
    paths.add(relativePath);
    if (
      !/^[A-Za-z0-9_-]+$/.test(category) ||
      path.basename(storedName) !== storedName ||
      storedName === "." ||
      storedName === ".." ||
      storedName.includes("\\")
    ) {
      throw new Error(`Unsafe legacy file path: ${relativePath}`);
    }
    if (!Number.isSafeInteger(item.size) || item.size < 0) {
      throw new Error(`Legacy resource size must be a non-negative integer: ${id}`);
    }
    const tags = item.tags === undefined ? [] : item.tags;
    const annotations = item.annotations === undefined ? [] : item.annotations;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
      throw new Error(`Legacy resource tags must be an array of strings: ${id}`);
    }
    if (!Array.isArray(annotations)) {
      throw new Error(`Legacy resource annotations must be an array: ${id}`);
    }
    const createdAt = validIso(item.uploadedAt, "uploadedAt");
    const normalizedAnnotations = annotations.map((annotation, annotationIndex) => {
      if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) {
        throw new Error(`Invalid annotation ${annotationIndex} on legacy resource ${id}.`);
      }
      const annotationId = cleanLegacyString(annotation.id, "annotation.id", { required: true });
      const page = Number(annotation.page);
      if (!Number.isInteger(page) || page < 1 || page > 9999) {
        throw new Error(`Invalid annotation page on legacy resource ${id}.`);
      }
      return {
        id: annotationId,
        page,
        text: cleanLegacyString(annotation.text, "annotation.text", { required: true }),
        color: cleanLegacyString(annotation.color, "annotation.color") || "amber",
        createdAt: annotation.createdAt ? validIso(annotation.createdAt, "annotation.createdAt") : createdAt
      };
    });
    const capo = item.capo === undefined || item.capo === null ? null : Number(item.capo);
    const bpm = item.bpm === undefined || item.bpm === null ? null : Number(item.bpm);
    if (capo !== null && (!Number.isInteger(capo) || capo < 0 || capo > 24)) {
      throw new Error(`Legacy resource capo is invalid: ${id}`);
    }
    if (bpm !== null && (!Number.isInteger(bpm) || bpm < 20 || bpm > 400)) {
      throw new Error(`Legacy resource bpm is invalid: ${id}`);
    }
    return {
      id,
      title,
      artist: cleanLegacyString(item.artist, "artist"),
      key: cleanLegacyString(item.key, "key"),
      capo,
      bpm,
      notes: cleanLegacyString(item.notes, "notes"),
      tags,
      category,
      sheetKind: ["pdf", "image", "chart", "other"].includes(item.sheetKind)
        ? item.sheetKind
        : kindForExtension(extension),
      originalName,
      storedName,
      extension,
      size: item.size,
      createdAt,
      updatedAt: item.updatedAt ? validIso(item.updatedAt, "updatedAt") : createdAt,
      searchText: cleanLegacyString(item.searchText, "searchText"),
      searchStatus: cleanLegacyString(item.searchStatus, "searchStatus") || "empty",
      indexedAt: item.indexedAt ? validIso(item.indexedAt, "indexedAt") : null,
      annotations: normalizedAnnotations
    };
  });
}

async function createLegacyBackup(catalogPath) {
  const raw = await fsp.readFile(catalogPath);
  const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const backupPath = `${catalogPath}.migration-backup-${digest}.json`;
  try {
    await fsp.writeFile(backupPath, raw, { flag: "wx", mode: 0o444 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await fsp.chmod(backupPath, 0o444);
  return { backupPath, raw };
}

function ensureMigrationActor(db, timestamp) {
  db.prepare(`
    INSERT OR IGNORE INTO users
      (id, login_identifier, display_name, password_hash, role, enabled,
       must_change_password, is_system, created_at, updated_at)
    VALUES (?, NULL, ?, NULL, 'admin', 0, 0, 1, ?, ?)
  `).run(MIGRATION_ACTOR_ID, MIGRATION_ACTOR_NAME, timestamp, timestamp);
}

async function migrateLegacyCatalog(db, catalogPath, options = {}) {
  const prior = db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(LEGACY_IMPORT_KEY);
  if (prior) return { status: "already-migrated", imported: 0, backupPath: JSON.parse(prior.value).backupPath };

  let source;
  try {
    source = await createLegacyBackup(catalogPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      const existing = db.prepare("SELECT COUNT(*) AS count FROM resources").get().count;
      if (existing !== 0) {
        throw new Error("Legacy catalog is missing while the uninitialized database contains resources.");
      }
      db.prepare(
        "INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)"
      ).run(LEGACY_IMPORT_KEY, JSON.stringify({ source: "missing-first-initialization" }), nowIso());
      return { status: "initialized-empty", imported: 0, backupPath: null };
    }
    throw new Error(`Legacy catalog is unreadable: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(source.raw.toString("utf8"));
  } catch (error) {
    throw new Error(`Legacy catalog contains malformed JSON: ${error.message}`);
  }
  const resources = validateLegacyCatalog(parsed);
  const timestamp = nowIso();
  const importTransaction = db.transaction(() => {
    const existing = db.prepare("SELECT COUNT(*) AS count FROM resources").get().count;
    if (existing !== 0) {
      throw new Error("Cannot import a legacy catalog into a non-empty database.");
    }
    ensureMigrationActor(db, timestamp);
    const insertResource = db.prepare(`
      INSERT INTO resources
        (id, title, artist, musical_key, capo, bpm, notes, tags_json, sheet_kind,
         search_text, search_status, indexed_at, uploaded_by, updated_by, created_at, updated_at)
      VALUES
        (@id, @title, @artist, @key, @capo, @bpm, @notes, @tagsJson, @sheetKind,
         @searchText, @searchStatus, @indexedAt, @actor, @actor, @createdAt, @updatedAt)
    `);
    const insertFile = db.prepare(`
      INSERT INTO resource_files
        (id, resource_id, ordinal, category, original_name, stored_name, extension, size, created_at)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
    `);
    const insertAnnotation = db.prepare(`
      INSERT INTO annotations
        (id, resource_id, user_id, page, text, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const resource of resources) {
      insertResource.run({
        ...resource,
        tagsJson: JSON.stringify(resource.tags),
        actor: MIGRATION_ACTOR_ID
      });
      insertFile.run(
        crypto.randomUUID(), resource.id, resource.category, resource.originalName,
        resource.storedName, resource.extension, resource.size, resource.createdAt
      );
      for (const annotation of resource.annotations) {
        insertAnnotation.run(
          annotation.id, resource.id, MIGRATION_ACTOR_ID, annotation.page,
          annotation.text, annotation.color, annotation.createdAt, annotation.createdAt
        );
      }
    }
    db.prepare(`
      INSERT INTO audit_events
        (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
      VALUES (?, 'legacy_catalog_imported', 'catalog', NULL, ?, ?)
    `).run(MIGRATION_ACTOR_ID, timestamp, JSON.stringify({ resources: resources.length }));
    db.prepare(
      "INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)"
    ).run(
      LEGACY_IMPORT_KEY,
      JSON.stringify({ source: catalogPath, backupPath: source.backupPath, resources: resources.length }),
      timestamp
    );
    if (options.beforeCommit) options.beforeCommit(db);
  });
  importTransaction();
  return { status: "migrated", imported: resources.length, backupPath: source.backupPath };
}

function mapResourceRow(row, annotations = []) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    key: row.musical_key,
    capo: row.capo,
    bpm: row.bpm,
    notes: row.notes,
    tags: JSON.parse(row.tags_json),
    category: row.category,
    sheetKind: row.sheet_kind,
    originalName: row.original_name,
    storedName: row.stored_name,
    extension: row.extension,
    size: row.size,
    uploadedAt: row.created_at,
    updatedAt: row.updated_at,
    uploadedBy: row.uploaded_by,
    updatedBy: row.updated_by,
    searchText: row.search_text,
    searchStatus: row.search_status,
    indexedAt: row.indexed_at,
    visibility: row.visibility || "restricted",
    annotations
  };
}

function createCatalogStore(db) {
  const baseSelect = `
    SELECT r.*, f.category, f.original_name, f.stored_name, f.extension, f.size
    FROM resources r
    JOIN resource_files f ON f.resource_id = r.id AND f.ordinal = 0
    WHERE r.deleted_at IS NULL
  `;
  function listResources() {
    const annotationRows = db.prepare("SELECT * FROM annotations ORDER BY created_at").all();
    const byResource = new Map();
    for (const row of annotationRows) {
      const list = byResource.get(row.resource_id) || [];
      list.push({
        id: row.id,
        userId: row.user_id,
        page: row.page,
        text: row.text,
        color: row.color,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
      byResource.set(row.resource_id, list);
    }
    return db.prepare(baseSelect).all().map((row) => mapResourceRow(row, byResource.get(row.id) || []));
  }
  function replaceResources(resources, actorId = MIGRATION_ACTOR_ID) {
    db.transaction(() => {
      for (const resource of resources) {
        const current = db.prepare("SELECT id FROM resources WHERE id = ?").get(resource.id);
        if (!current) {
          db.prepare(`
            INSERT INTO resources
              (id, title, artist, musical_key, capo, bpm, notes, tags_json, sheet_kind,
               search_text, search_status, indexed_at, uploaded_by, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            resource.id, resource.title, resource.artist || "", resource.key || "",
            resource.capo ?? null, resource.bpm ?? null, resource.notes || "",
            JSON.stringify(resource.tags || []), resource.sheetKind || kindForExtension(resource.extension),
            resource.searchText || "", resource.searchStatus || "empty", resource.indexedAt || null,
            resource.uploadedBy || actorId, resource.updatedBy || actorId,
            resource.uploadedAt || nowIso(), resource.updatedAt || resource.uploadedAt || nowIso()
          );
          db.prepare(`
            INSERT INTO resource_files
              (id, resource_id, ordinal, category, original_name, stored_name, extension, size, created_at)
            VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
          `).run(
            crypto.randomUUID(), resource.id, resource.category, resource.originalName,
            resource.storedName, resource.extension, resource.size, resource.uploadedAt || nowIso()
          );
        } else {
          db.prepare(`
            UPDATE resources SET title=?, artist=?, musical_key=?, capo=?, bpm=?, notes=?,
              tags_json=?, sheet_kind=?, search_text=?, search_status=?, indexed_at=?,
              updated_by=?, updated_at=? WHERE id=?
          `).run(
            resource.title, resource.artist || "", resource.key || "", resource.capo ?? null,
            resource.bpm ?? null, resource.notes || "", JSON.stringify(resource.tags || []),
            resource.sheetKind || kindForExtension(resource.extension), resource.searchText || "",
            resource.searchStatus || "empty", resource.indexedAt || null,
            resource.updatedBy || actorId, resource.updatedAt || nowIso(), resource.id
          );
          db.prepare("DELETE FROM annotations WHERE resource_id = ?").run(resource.id);
        }
        const annotationInsert = db.prepare(`
          INSERT INTO annotations
            (id, resource_id, user_id, page, text, color, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const annotation of resource.annotations || []) {
          annotationInsert.run(
            annotation.id, resource.id, annotation.userId || actorId, annotation.page,
            annotation.text, annotation.color || "amber", annotation.createdAt || nowIso(),
            annotation.updatedAt || annotation.createdAt || nowIso()
          );
        }
      }
      const retained = new Set(resources.map((resource) => resource.id));
      for (const row of db.prepare("SELECT id FROM resources WHERE deleted_at IS NULL").all()) {
        if (!retained.has(row.id)) {
          const timestamp = nowIso();
          db.prepare(
            "UPDATE resources SET deleted_at=?, deleted_by=?, updated_at=?, updated_by=? WHERE id=?"
          ).run(timestamp, actorId, timestamp, actorId, row.id);
          db.prepare(`
            INSERT INTO audit_events
              (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
            VALUES (?, 'resource_deleted', 'resource', ?, ?, '{}')
          `).run(actorId, row.id, timestamp);
        }
      }
    })();
  }
  return { listResources, replaceResources };
}

module.exports = {
  EMERGENCY_ACTOR_ID,
  EMERGENCY_ACTOR_NAME,
  CURRENT_SCHEMA_VERSION,
  LEGACY_IMPORT_KEY,
  MIGRATION_ACTOR_ID,
  createCatalogStore,
  migrateLegacyCatalog,
  openDatabase,
  validateLegacyCatalog
};
