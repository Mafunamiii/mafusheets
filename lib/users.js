"use strict";

const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("./passwords");

function normalizeLoginIdentifier(value) {
  const login = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@+-]{2,127}$/.test(login)) {
    throw new Error("Login identifier must be 3-128 characters using letters, numbers, or ._@+-.");
  }
  return login;
}

function normalizeRole(value) {
  if (value !== "admin" && value !== "member") {
    throw new Error("Role must be admin or member.");
  }
  return value;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    loginIdentifier: row.login_identifier,
    displayName: row.display_name,
    role: row.role,
    enabled: Boolean(row.enabled),
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at
  };
}

function createUserStore(db) {
  function enabledAdminCount() {
    return db.prepare(
      "SELECT COUNT(*) count FROM users WHERE role='admin' AND enabled=1 AND is_system=0"
    ).get().count;
  }

  async function createUser({
    loginIdentifier,
    displayName,
    password,
    role = "member",
    enabled = true,
    mustChangePassword = false
  }) {
    const login = normalizeLoginIdentifier(loginIdentifier);
    const name = String(displayName || "").trim();
    if (!name || name.length > 120) throw new Error("Display name is required and must be at most 120 characters.");
    const passwordHash = await hashPassword(password);
    const timestamp = new Date().toISOString();
    const id = crypto.randomUUID();
    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO users
            (id, login_identifier, display_name, password_hash, role, enabled,
             must_change_password, is_system, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
          id, login, name, passwordHash, normalizeRole(role), enabled ? 1 : 0,
          mustChangePassword ? 1 : 0, timestamp, timestamp
        );
        db.prepare(`
          INSERT INTO audit_events
            (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
          VALUES (NULL, 'account_created', 'user', ?, ?, ?)
        `).run(id, timestamp, JSON.stringify({ loginIdentifier: login, role }));
      })();
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error(`An account already exists for ${login}.`);
      }
      throw error;
    }
    return getUserById(id);
  }

  function getUserById(id) {
    return publicUser(db.prepare("SELECT * FROM users WHERE id = ? AND is_system = 0").get(id));
  }

  function getUserByLogin(loginIdentifier) {
    const login = normalizeLoginIdentifier(loginIdentifier);
    return db.prepare("SELECT * FROM users WHERE login_identifier = ? AND is_system = 0").get(login) || null;
  }

  async function authenticate(loginIdentifier, password) {
    let row;
    try {
      row = getUserByLogin(loginIdentifier);
    } catch {
      return null;
    }
    if (!row || !row.enabled || !(await verifyPassword(password, row.password_hash))) return null;
    const timestamp = new Date().toISOString();
    db.prepare("UPDATE users SET last_login_at=?, updated_at=? WHERE id=?").run(timestamp, timestamp, row.id);
    return getUserById(row.id);
  }

  function setEnabled(id, enabled) {
    const timestamp = new Date().toISOString();
    db.transaction(() => {
      const current = db.prepare(
        "SELECT role, enabled FROM users WHERE id=? AND is_system=0"
      ).get(id);
      if (!current) throw new Error("User not found.");
      if (!enabled && current.enabled && current.role === "admin" && enabledAdminCount() <= 1) {
        throw new Error("Cannot disable the last enabled administrator.");
      }
      const result = db.prepare(
        "UPDATE users SET enabled=?, updated_at=? WHERE id=? AND is_system=0"
      ).run(enabled ? 1 : 0, timestamp, id);
      if (!result.changes) throw new Error("User not found.");
      if (!enabled) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      db.prepare(`
        INSERT INTO audit_events
          (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
        VALUES (NULL, ?, 'user', ?, ?, '{}')
      `).run(enabled ? "account_enabled" : "account_disabled", id, timestamp);
    })();
    return getUserById(id);
  }

  async function resetPassword(id, password, { mustChangePassword = true } = {}) {
    const passwordHash = await hashPassword(password);
    const timestamp = new Date().toISOString();
    db.transaction(() => {
      const result = db.prepare(`
        UPDATE users SET password_hash=?, must_change_password=?, updated_at=?
        WHERE id=? AND is_system=0
      `).run(passwordHash, mustChangePassword ? 1 : 0, timestamp, id);
      if (!result.changes) throw new Error("User not found.");
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      db.prepare(`
        INSERT INTO audit_events
          (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
        VALUES (NULL, 'password_reset', 'user', ?, ?, ?)
      `).run(id, timestamp, JSON.stringify({ mustChangePassword: Boolean(mustChangePassword) }));
    })();
    return getUserById(id);
  }

  async function changePassword(id, currentPassword, password) {
    const row = db.prepare("SELECT * FROM users WHERE id=? AND is_system=0 AND enabled=1").get(id);
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
      throw new Error("Current password is incorrect.");
    }
    const passwordHash = await hashPassword(password);
    const timestamp = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?
      `).run(passwordHash, timestamp, id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      db.prepare(`
        INSERT INTO audit_events
          (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
        VALUES (?, 'password_changed', 'user', ?, ?, '{}')
      `).run(id, id, timestamp);
    })();
    return getUserById(id);
  }

  function setRole(id, role) {
    const nextRole = normalizeRole(role);
    const timestamp = new Date().toISOString();
    db.transaction(() => {
      const current = db.prepare(
        "SELECT role, enabled FROM users WHERE id=? AND is_system=0"
      ).get(id);
      if (!current) throw new Error("User not found.");
      if (
        current.role === "admin" && nextRole !== "admin" && current.enabled &&
        enabledAdminCount() <= 1
      ) {
        throw new Error("Cannot demote the last enabled administrator.");
      }
      db.prepare("UPDATE users SET role=?, updated_at=? WHERE id=?").run(nextRole, timestamp, id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      db.prepare(`
        INSERT INTO audit_events
          (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
        VALUES (NULL, 'role_changed', 'user', ?, ?, ?)
      `).run(id, timestamp, JSON.stringify({ from: current.role, to: nextRole }));
    })();
    return getUserById(id);
  }

  function listUsers() {
    return db.prepare("SELECT * FROM users WHERE is_system=0 ORDER BY login_identifier").all().map(publicUser);
  }

  return {
    authenticate,
    changePassword,
    createUser,
    getUserById,
    listUsers,
    resetPassword,
    setEnabled,
    setRole
  };
}

module.exports = { createUserStore, normalizeLoginIdentifier, normalizeRole };
