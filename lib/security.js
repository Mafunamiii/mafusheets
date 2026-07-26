"use strict";

const crypto = require("crypto");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PLACEHOLDER_SECRETS = new Set([
  "change-me",
  "change-me-to-a-long-random-string",
  "changeme",
  "replace-me",
  "your-secret-here",
  "secret",
  "password"
]);

function requireSessionSecret(value) {
  const secret = String(value || "").trim();
  const normalized = secret.toLowerCase();
  if (
    secret.length < 32 ||
    PLACEHOLDER_SECRETS.has(normalized) ||
    /^(.)\1+$/.test(secret) ||
    /^(change|replace|example|sample|default|test|dev)[-_ ]/i.test(secret)
  ) {
    throw new Error(
      "SESSION_SECRET must be configured with at least 32 non-placeholder characters."
    );
  }
  return secret;
}

function digest(secret, value) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}

function createSessionStore(db, secret, ttlMs = SESSION_TTL_MS) {
  function issue(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = digest(secret, `csrf:${token}`);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    db.prepare(`
      INSERT INTO sessions
        (token_hash, user_id, csrf_token_hash, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      digest(secret, token), userId, digest(secret, csrfToken),
      now.toISOString(), now.toISOString(), expiresAt.toISOString()
    );
    return { token, csrfToken, expiresAt: expiresAt.getTime() };
  }

  function validate(token) {
    if (!token) return null;
    const tokenHash = digest(secret, token);
    const row = db.prepare(`
      SELECT s.*, u.login_identifier, u.display_name, u.role, u.enabled,
             u.must_change_password
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND u.is_system=0
    `).get(tokenHash);
    if (!row || !row.enabled || Date.parse(row.expires_at) <= Date.now()) {
      if (row) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
      return null;
    }
    db.prepare("UPDATE sessions SET last_seen_at=? WHERE token_hash=?")
      .run(new Date().toISOString(), tokenHash);
    return {
      token,
      tokenHash,
      userId: row.user_id,
      user: row.login_identifier,
      displayName: row.display_name,
      role: row.role,
      mustChangePassword: Boolean(row.must_change_password),
      csrfToken: digest(secret, `csrf:${token}`),
      expiresAt: Date.parse(row.expires_at)
    };
  }

  function verifyCsrf(session, csrfToken) {
    if (!session || !csrfToken) return false;
    const actual = Buffer.from(digest(secret, csrfToken), "hex");
    const row = db.prepare("SELECT csrf_token_hash FROM sessions WHERE token_hash=?")
      .get(session.tokenHash);
    if (!row) return false;
    return crypto.timingSafeEqual(actual, Buffer.from(row.csrf_token_hash, "hex"));
  }

  function revoke(token) {
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(secret, token));
  }

  function revokeUser(userId) {
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
  }

  function purgeExpired() {
    db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(new Date().toISOString());
  }

  return { issue, purgeExpired, revoke, revokeUser, validate, verifyCsrf };
}

function auditEvent(db, {
  actorUserId = null,
  eventType,
  entityType,
  entityId = null,
  details = {}
}) {
  db.prepare(`
    INSERT INTO audit_events
      (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    actorUserId, eventType, entityType, entityId,
    new Date().toISOString(), JSON.stringify(details)
  );
}

module.exports = {
  SESSION_TTL_MS,
  auditEvent,
  createSessionStore,
  digest,
  requireSessionSecret
};
