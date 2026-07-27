"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function nowIso() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value || {});
}

function moveFileSync(source, destination) {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("Refusing to move a non-regular or symbolic-link file.");
  }
  if (fs.existsSync(destination)) {
    throw new Error("Refusing to overwrite an existing file.");
  }
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    try {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(source);
    } catch (copyError) {
      try { fs.unlinkSync(destination); } catch {}
      throw copyError;
    }
  }
}

function createResourceStore(db) {
  const selectResource = db.prepare(`
    SELECT r.*, f.id file_id, f.category, f.original_name, f.stored_name,
           f.extension, f.size
    FROM resources r
    JOIN resource_files f ON f.resource_id=r.id AND f.ordinal=0
    WHERE r.id=? AND r.deleted_at IS NULL
  `);

  function transactionImmediate(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  function audit(actorId, eventType, entityType, entityId, details = {}) {
    db.prepare(`
      INSERT INTO audit_events
        (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(actorId || null, eventType, entityType, entityId || null, nowIso(), json(details));
  }

  function recordFailure({ operationType, actorId, resourceId = null, error, details = {} }) {
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO pending_operations
          (id, operation_type, resource_id, actor_user_id, status, details_json,
           error_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), operationType, resourceId, actorId || null, json(details),
        String(error && error.message || error).slice(0, 1000), timestamp, timestamp
      );
      audit(actorId, `${operationType}_failed`, resourceId ? "resource" : "catalog", resourceId, {
        reason: String(error && error.message || error).slice(0, 240)
      });
    })();
  }

  function acquireLock(lockKey, ownerId, ttlMs = 120000) {
    const timestamp = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    return transactionImmediate(() => {
      db.prepare("DELETE FROM operation_locks WHERE expires_at<=?").run(timestamp);
      try {
        db.prepare(`
          INSERT INTO operation_locks (lock_key, owner_id, acquired_at, expires_at)
          VALUES (?, ?, ?, ?)
        `).run(lockKey, ownerId, timestamp, expiresAt);
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
          throw new Error(`Operation is already in progress for ${lockKey}.`);
        }
        throw error;
      }
      return () => db.prepare(
        "DELETE FROM operation_locks WHERE lock_key=? AND owner_id=?"
      ).run(lockKey, ownerId);
    });
  }

  function createBatch(resources, moves, actorId, hooks = {}) {
    const operationId = crypto.randomUUID();
    const thumbnailOperations = [];
    const moved = [];
    try {
      hooks.beforeStagingCheck?.();
      if (!resources.length || resources.length !== moves.length) {
        throw new Error("The staged upload batch is incomplete.");
      }
      for (let index = 0; index < moves.length; index += 1) {
        const stat = fs.lstatSync(moves[index].stagedPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== resources[index].size) {
          throw new Error("A staged upload does not match its validated metadata.");
        }
      }
      hooks.beforeValidation?.();
      const finalPaths = new Set(moves.map((move) => path.resolve(move.finalPath)));
      if (finalPaths.size !== moves.length) {
        throw new Error("The upload batch contains duplicate final storage paths.");
      }
      hooks.beforeDatabaseInsert?.();
      transactionImmediate(() => {
        const timestamp = nowIso();
        db.prepare(`
          INSERT INTO pending_operations
            (id, operation_type, actor_user_id, status, details_json, created_at, updated_at)
          VALUES (?, 'upload', ?, 'pending', ?, ?, ?)
        `).run(operationId, actorId, json({ resourceIds: resources.map((item) => item.id) }), timestamp, timestamp);
        const insertResource = db.prepare(`
          INSERT INTO resources
            (id, title, artist, musical_key, capo, bpm, notes, tags_json, sheet_kind,
             search_text, search_status, indexed_at, uploaded_by, updated_by, created_at, updated_at)
          VALUES
            (@id, @title, @artist, @key, @capo, @bpm, @notes, @tagsJson, @sheetKind,
             @searchText, @searchStatus, @indexedAt, @actor, @actor, @createdAt, @createdAt)
        `);
        const insertFile = db.prepare(`
          INSERT INTO resource_files
            (id, resource_id, ordinal, category, original_name, stored_name, extension, size, created_at)
          VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
        `);
        for (const resource of resources) {
          insertResource.run({
            ...resource,
            tagsJson: json(resource.tags),
            actor: actorId,
            createdAt: resource.uploadedAt
          });
          insertFile.run(
            crypto.randomUUID(), resource.id, resource.category, resource.originalName,
            resource.storedName, resource.extension, resource.size, resource.uploadedAt
          );
        }
        for (const move of moves) {
          hooks.beforeFileMove?.(move, moved.length);
          moveFileSync(move.stagedPath, move.finalPath);
          moved.push(move);
        }
        hooks.beforeThumbnailEnqueue?.();
        for (const resource of resources) {
          if (![".pdf", ".png", ".jpg", ".jpeg"].includes(resource.extension)) continue;
          const thumbnailOperationId = crypto.randomUUID();
          db.prepare(`
            INSERT INTO pending_operations
              (id, operation_type, resource_id, actor_user_id, status, details_json,
               created_at, updated_at)
            VALUES (?, 'thumbnail', ?, ?, 'pending', '{}', ?, ?)
          `).run(thumbnailOperationId, resource.id, actorId, timestamp, timestamp);
          thumbnailOperations.push({
            operationId: thumbnailOperationId,
            resourceId: resource.id
          });
        }
        db.prepare(`
          UPDATE pending_operations SET status='completed', updated_at=? WHERE id=?
        `).run(nowIso(), operationId);
        db.prepare(`
          INSERT INTO upload_usage (id, user_id, bytes, occurred_at) VALUES (?, ?, ?, ?)
        `).run(
          crypto.randomUUID(), actorId,
          resources.reduce((total, resource) => total + resource.size, 0), timestamp
        );
        audit(actorId, "upload_completed", "catalog", null, {
          operationId, resourceIds: resources.map((item) => item.id)
        });
      });
      return { resources, thumbnailOperations };
    } catch (error) {
      for (const move of moved.reverse()) {
        try {
          moveFileSync(move.finalPath, move.stagedPath);
        } catch {
          try { fs.unlinkSync(move.finalPath); } catch {}
        }
      }
      recordFailure({
        operationType: "upload", actorId, error,
        details: { resourceIds: resources.map((item) => item.id) }
      });
      throw error;
    }
  }

  function finishOperation(operationId, error = null) {
    const timestamp = nowIso();
    const result = db.prepare(`
      UPDATE pending_operations SET status=?, error_text=?, updated_at=?
      WHERE id=? AND status='pending'
    `).run(
      error ? "failed" : "completed",
      error ? String(error.message || error).slice(0, 1000) : null,
      timestamp,
      operationId
    );
    return Boolean(result.changes);
  }

  function finishPendingThumbnails(resourceId) {
    return db.prepare(`
      UPDATE pending_operations SET status='completed', error_text=NULL, updated_at=?
      WHERE operation_type='thumbnail' AND resource_id=? AND status IN ('pending', 'failed')
    `).run(nowIso(), resourceId).changes;
  }

  function updateMetadata(id, updates, actorId, hooks = {}) {
    return transactionImmediate(() => {
      const current = selectResource.get(id);
      if (!current) return null;
      hooks.beforeMetadataUpdate?.();
      const timestamp = nowIso();
      db.prepare(`
        UPDATE resources SET title=?, artist=?, musical_key=?, capo=?, bpm=?, notes=?,
          tags_json=?, updated_by=?, updated_at=?
        WHERE id=? AND deleted_at IS NULL
      `).run(
        updates.title, updates.artist, updates.key, updates.capo, updates.bpm,
        updates.notes, json(updates.tags), actorId, timestamp, id
      );
      audit(actorId, "resource_updated", "resource", id);
      return { timestamp };
    });
  }

  function createAnnotation(resourceId, annotation, actorId, hooks = {}) {
    return transactionImmediate(() => {
      if (!selectResource.get(resourceId)) return null;
      hooks.beforeAnnotationWrite?.();
      const timestamp = nowIso();
      db.prepare(`
        INSERT INTO annotations
          (id, resource_id, user_id, page, text, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        annotation.id, resourceId, actorId, annotation.page, annotation.text,
        annotation.color, timestamp, timestamp
      );
      db.prepare("UPDATE resources SET updated_by=?, updated_at=? WHERE id=?")
        .run(actorId, timestamp, resourceId);
      audit(actorId, "annotation_created", "annotation", annotation.id, { resourceId });
      return { ...annotation, userId: actorId, createdAt: timestamp, updatedAt: timestamp };
    });
  }

  function deleteAnnotation(resourceId, annotationId, actorId, isAdmin, hooks = {}) {
    return transactionImmediate(() => {
      const annotation = db.prepare(`
        SELECT a.* FROM annotations a JOIN resources r ON r.id=a.resource_id
        WHERE a.id=? AND a.resource_id=? AND r.deleted_at IS NULL
      `).get(annotationId, resourceId);
      if (!annotation) return { status: "missing" };
      if (!isAdmin && annotation.user_id !== actorId) return { status: "forbidden" };
      hooks.beforeAnnotationWrite?.();
      db.prepare("DELETE FROM annotations WHERE id=?").run(annotationId);
      const timestamp = nowIso();
      db.prepare("UPDATE resources SET updated_by=?, updated_at=? WHERE id=?")
        .run(actorId, timestamp, resourceId);
      audit(actorId, "annotation_deleted", "annotation", annotationId, { resourceId });
      return { status: "deleted" };
    });
  }

  function updateSearchIndex(id, expectedUpdatedAt, result, actorId) {
    return transactionImmediate(() => {
      const timestamp = nowIso();
      const changed = db.prepare(`
        UPDATE resources SET search_text=?, search_status=?, indexed_at=?,
          updated_by=?, updated_at=?
        WHERE id=? AND deleted_at IS NULL AND updated_at=?
      `).run(
        result.searchText, result.searchStatus, timestamp, actorId, timestamp,
        id, expectedUpdatedAt
      ).changes;
      if (changed) audit(actorId, "resource_reindexed", "resource", id);
      return Boolean(changed);
    });
  }

  function replaceFile(resourceId, replacement, actorId, hooks = {}) {
    const ownerId = crypto.randomUUID();
    const release = acquireLock(`resource:${resourceId}`, ownerId);
    const operationId = crypto.randomUUID();
    let originalMoved = false;
    let replacementMoved = false;
    let thumbnailOperationId = null;
    try {
      const result = transactionImmediate(() => {
        const current = selectResource.get(resourceId);
        if (!current) return null;
        const timestamp = nowIso();
        db.prepare(`
          INSERT INTO pending_operations
            (id, operation_type, resource_id, actor_user_id, status, details_json,
             created_at, updated_at)
          VALUES (?, 'replacement', ?, ?, 'pending', ?, ?, ?)
        `).run(operationId, resourceId, actorId, json({
          oldPath: replacement.originalPath,
          stagedPath: replacement.stagedPath,
          finalPath: replacement.finalPath,
          backupPath: replacement.backupPath
        }), timestamp, timestamp);
        hooks.beforeReplacementMove?.();
        moveFileSync(replacement.originalPath, replacement.backupPath);
        originalMoved = true;
        moveFileSync(replacement.stagedPath, replacement.finalPath);
        replacementMoved = true;
        hooks.beforeReplacementDatabaseUpdate?.();
        db.prepare(`
          UPDATE resource_files SET category=?, original_name=?, stored_name=?,
            extension=?, size=?, created_at=? WHERE id=?
        `).run(
          replacement.category, replacement.originalName, replacement.storedName,
          replacement.extension, replacement.size, timestamp, current.file_id
        );
        db.prepare(`
          UPDATE resources SET sheet_kind=?, search_text=?, search_status=?, indexed_at=?,
            updated_by=?, updated_at=? WHERE id=?
        `).run(
          replacement.sheetKind, replacement.searchText, replacement.searchStatus,
          timestamp, actorId, timestamp, resourceId
        );
        if ([".pdf", ".png", ".jpg", ".jpeg"].includes(replacement.extension)) {
          hooks.beforeReplacementThumbnailEnqueue?.();
          thumbnailOperationId = crypto.randomUUID();
          db.prepare(`
            INSERT INTO pending_operations
              (id, operation_type, resource_id, actor_user_id, status, details_json,
               created_at, updated_at)
            VALUES (?, 'thumbnail', ?, ?, 'pending', '{}', ?, ?)
          `).run(thumbnailOperationId, resourceId, actorId, timestamp, timestamp);
        }
        db.prepare("UPDATE pending_operations SET status='completed', updated_at=? WHERE id=?")
          .run(timestamp, operationId);
        db.prepare(`
          INSERT INTO upload_usage (id, user_id, bytes, occurred_at) VALUES (?, ?, ?, ?)
        `).run(crypto.randomUUID(), actorId, replacement.size, timestamp);
        audit(actorId, "resource_file_replaced", "resource", resourceId, { operationId });
        return { thumbnailOperationId };
      });
      if (result === null) return null;
      try { fs.unlinkSync(replacement.backupPath); } catch (error) {
        recordFailure({
          operationType: "cleanup", actorId, resourceId, error,
          details: { path: replacement.backupPath, operationId }
        });
      }
      return result;
    } catch (error) {
      if (replacementMoved) {
        try { fs.unlinkSync(replacement.finalPath); } catch {}
      }
      if (originalMoved) {
        try { moveFileSync(replacement.backupPath, replacement.originalPath); } catch {}
      }
      recordFailure({
        operationType: "replacement", actorId, resourceId, error,
        details: { operationId, backupPath: replacement.backupPath }
      });
      throw error;
    } finally {
      release();
    }
  }

  function deleteResource(resourceId, actorId, artifacts, hooks = {}) {
    const ownerId = crypto.randomUUID();
    const release = acquireLock(`resource:${resourceId}`, ownerId);
    const operationId = crypto.randomUUID();
    const moved = [];
    try {
      const result = transactionImmediate(() => {
        const current = selectResource.get(resourceId);
        if (!current) return null;
        const timestamp = nowIso();
        db.prepare(`
          INSERT INTO pending_operations
            (id, operation_type, resource_id, actor_user_id, status, details_json,
             created_at, updated_at)
          VALUES (?, 'deletion', ?, ?, 'pending', ?, ?, ?)
        `).run(operationId, resourceId, actorId, json({ artifacts }), timestamp, timestamp);
        for (const artifact of artifacts) {
          if (!fs.existsSync(artifact.source)) {
            if (artifact.required) throw new Error(`Required artifact is missing: ${artifact.source}`);
            continue;
          }
          hooks.beforeDeletionMove?.(artifact, moved.length);
          fs.mkdirSync(path.dirname(artifact.quarantine), { recursive: true });
          moveFileSync(artifact.source, artifact.quarantine);
          moved.push(artifact);
        }
        hooks.beforeDatabaseDelete?.();
        db.prepare(`
          UPDATE resources SET deleted_at=?, deleted_by=?, updated_at=?, updated_by=?
          WHERE id=? AND deleted_at IS NULL
        `).run(timestamp, actorId, timestamp, actorId, resourceId);
        db.prepare(`
          UPDATE pending_operations SET status='quarantined', updated_at=? WHERE id=?
        `).run(timestamp, operationId);
        audit(actorId, "resource_deleted", "resource", resourceId, {
          operationId, result: "quarantined"
        });
        return { operationId };
      });
      return result;
    } catch (error) {
      for (const artifact of moved.reverse()) {
        try { moveFileSync(artifact.quarantine, artifact.source); } catch {}
      }
      recordFailure({
        operationType: "deletion", actorId, resourceId, error,
        details: { operationId, artifacts }
      });
      throw error;
    } finally {
      release();
    }
  }

  function finalizeDeletion(operationId, actorId, hooks = {}) {
    const operation = db.prepare(`
      SELECT * FROM pending_operations
      WHERE id=? AND operation_type='deletion' AND status='quarantined'
    `).get(operationId);
    if (!operation) return false;
    const details = JSON.parse(operation.details_json);
    try {
      transactionImmediate(() => {
        hooks.beforeDeletionFinalize?.();
        db.prepare("DELETE FROM resource_files WHERE resource_id=?").run(operation.resource_id);
        db.prepare("DELETE FROM annotations WHERE resource_id=?").run(operation.resource_id);
      });
      for (const artifact of details.artifacts || []) {
        hooks.beforeFilesystemDeletion?.(artifact);
        if (fs.existsSync(artifact.quarantine)) fs.unlinkSync(artifact.quarantine);
      }
      transactionImmediate(() => {
        db.prepare("UPDATE pending_operations SET status='completed', updated_at=? WHERE id=?")
          .run(nowIso(), operationId);
        audit(actorId, "resource_deletion_finalized", "resource", operation.resource_id, {
          operationId, result: "complete"
        });
      });
      return true;
    } catch (error) {
      db.prepare(`
        UPDATE pending_operations SET status='failed', error_text=?, updated_at=? WHERE id=?
      `).run(String(error.message).slice(0, 1000), nowIso(), operationId);
      audit(actorId, "deletion_failed", "resource", operation.resource_id, {
        operationId, reason: String(error.message).slice(0, 240)
      });
      throw error;
    }
  }

  async function reportIntegrity({ uploadsDir, stagingDir, trashDir }) {
    const issues = [];
    for (const directory of [uploadsDir, stagingDir, trashDir]) {
      try {
        const stat = await fsp.stat(directory);
        if (!stat.isDirectory()) issues.push({ type: "missing_directory", path: directory });
      } catch {
        issues.push({ type: "missing_directory", path: directory });
      }
    }
    const duplicates = db.prepare(`
      SELECT category, stored_name, COUNT(*) count FROM resource_files
      GROUP BY category, stored_name HAVING COUNT(*)>1
    `).all();
    issues.push(...duplicates.map((row) => ({ type: "duplicate_storage_path", ...row })));
    const rows = db.prepare(`
      SELECT r.id, f.category, f.stored_name FROM resources r
      JOIN resource_files f ON f.resource_id=r.id AND f.ordinal=0
      WHERE r.deleted_at IS NULL
    `).all();
    for (const row of rows) {
      const filePath = path.join(uploadsDir, row.category, row.stored_name);
      try { await fsp.access(filePath); } catch {
        issues.push({ type: "missing_resource_file", resourceId: row.id, path: filePath });
      }
    }
    const incomplete = db.prepare(`
      SELECT id, operation_type, resource_id, status, details_json, error_text, updated_at
      FROM pending_operations WHERE status IN ('pending', 'quarantined', 'failed')
      ORDER BY created_at
    `).all();
    issues.push(...incomplete.map((row) => ({ type: "incomplete_operation", ...row })));
    return { ok: issues.length === 0, checkedAt: nowIso(), issues };
  }

  function repairOperation(operationId, actorId = null) {
    const operation = db.prepare("SELECT * FROM pending_operations WHERE id=?").get(operationId);
    if (!operation) throw new Error("Operation not found.");
    if (operation.operation_type !== "deletion") {
      throw new Error("Only deletion cleanup operations have an automatic repair.");
    }
    const resource = db.prepare("SELECT deleted_at FROM resources WHERE id=?")
      .get(operation.resource_id);
    if (!resource || !resource.deleted_at) {
      throw new Error("Deletion was not committed; no automatic data removal is safe.");
    }
    const ownerId = crypto.randomUUID();
    const release = acquireLock(`resource:${operation.resource_id}`, ownerId);
    try {
      const details = JSON.parse(operation.details_json);
      for (const artifact of details.artifacts || []) {
        if (fs.existsSync(artifact.quarantine)) fs.unlinkSync(artifact.quarantine);
      }
      transactionImmediate(() => {
        db.prepare("DELETE FROM resource_files WHERE resource_id=?").run(operation.resource_id);
        db.prepare("DELETE FROM annotations WHERE resource_id=?").run(operation.resource_id);
        db.prepare(`
          UPDATE pending_operations SET status='completed', error_text=NULL, updated_at=? WHERE id=?
        `).run(nowIso(), operationId);
        audit(actorId || operation.actor_user_id, "resource_deletion_repaired", "resource",
          operation.resource_id, { operationId });
      });
      return true;
    } finally {
      release();
    }
  }

  return {
    acquireLock,
    createAnnotation,
    createBatch,
    deleteResource,
    deleteAnnotation,
    finalizeDeletion,
    finishOperation,
    finishPendingThumbnails,
    recordFailure,
    repairOperation,
    replaceFile,
    reportIntegrity,
    transactionImmediate,
    updateMetadata,
    updateSearchIndex
  };
}

module.exports = { createResourceStore };
