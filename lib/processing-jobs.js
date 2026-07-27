"use strict";

const crypto = require("crypto");

function nowIso() {
  return new Date().toISOString();
}

function safeError(error) {
  return String(error && error.message || error)
    .replace(/[^\w .:-]/g, "")
    .slice(0, 500);
}

function createProcessingJobStore(db) {
  function enqueue(resourceId, actorUserId, maxAttempts = 2) {
    const existing = db.prepare(`
      SELECT id FROM processing_jobs
      WHERE resource_id=? AND status IN ('queued', 'running')
    `).get(resourceId);
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO processing_jobs
        (id, resource_id, actor_user_id, job_type, status, attempts, max_attempts,
         created_at, updated_at)
      VALUES (?, ?, ?, 'index_thumbnail', 'queued', 0, ?, ?, ?)
    `).run(id, resourceId, actorUserId, maxAttempts, timestamp, timestamp);
    return id;
  }

  function recoverInterrupted() {
    return db.prepare(`
      UPDATE processing_jobs SET status='queued', error_text='worker interrupted',
        updated_at=? WHERE status='running' AND attempts < max_attempts
    `).run(nowIso()).changes;
  }

  function enqueueMissing(maxAttempts = 2) {
    const resources = db.prepare(`
      SELECT r.id, r.uploaded_by FROM resources r
      WHERE r.deleted_at IS NULL AND r.search_status='pending'
        AND NOT EXISTS (
          SELECT 1 FROM processing_jobs j
          WHERE j.resource_id=r.id AND j.status IN ('queued', 'running')
        )
    `).all();
    for (const resource of resources) enqueue(resource.id, resource.uploaded_by, maxAttempts);
    return resources.length;
  }

  function next() {
    const job = db.prepare(`
      SELECT * FROM processing_jobs
      WHERE status='queued' AND attempts < max_attempts
      ORDER BY created_at LIMIT 1
    `).get();
    if (!job) return null;
    const timestamp = nowIso();
    const changed = db.prepare(`
      UPDATE processing_jobs SET status='running', attempts=attempts+1,
        started_at=?, updated_at=? WHERE id=? AND status='queued'
    `).run(timestamp, timestamp, job.id).changes;
    return changed ? { ...job, attempts: job.attempts + 1, status: "running" } : null;
  }

  function succeed(id) {
    const timestamp = nowIso();
    db.prepare(`
      UPDATE processing_jobs SET status='succeeded', error_text=NULL,
        finished_at=?, updated_at=? WHERE id=? AND status='running'
    `).run(timestamp, timestamp, id);
  }

  function fail(id, error) {
    const job = db.prepare("SELECT attempts, max_attempts FROM processing_jobs WHERE id=?").get(id);
    if (!job) return;
    const retry = job.attempts < job.max_attempts;
    const timestamp = nowIso();
    db.prepare(`
      UPDATE processing_jobs SET status=?, error_text=?, finished_at=?, updated_at=?
      WHERE id=?
    `).run(retry ? "queued" : "failed", safeError(error), retry ? null : timestamp, timestamp, id);
  }

  function counts() {
    return db.prepare(`
      SELECT status, COUNT(*) count FROM processing_jobs GROUP BY status
    `).all();
  }

  return { counts, enqueue, enqueueMissing, fail, next, recoverInterrupted, succeed };
}

module.exports = { createProcessingJobStore, safeError };
