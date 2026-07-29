"use strict";

const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("./passwords");
const { EMERGENCY_ACTOR_ID } = require("./database");

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
    approved: Boolean(row.approved),
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at
  };
}

function createUserStore(db) {
  function operatorDetails(operator) {
    if (!operator || !operator.actorUserId) {
      throw new Error("Administrative operator attribution is required.");
    }
    const actor = db.prepare("SELECT id, role, enabled, is_system FROM users WHERE id=?")
      .get(operator.actorUserId);
    const emergency = operator.mode === "emergency-system";
    if (!actor || (emergency
      ? actor.id !== EMERGENCY_ACTOR_ID || !actor.is_system
      : actor.is_system || actor.role !== "admin" || !actor.enabled)) {
      throw new Error("Administrative operator must be an enabled administrator.");
    }
    return {
      actorUserId: actor.id,
      audit: emergency ? { operatorMode: "emergency-system" } : {}
    };
  }

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
    mustChangePassword = false,
    operator = null,
    approved = true
  }) {
    const attributed = operatorDetails(operator);
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
             must_change_password, is_system, approved, approved_at, approved_by,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
        `).run(
          id, login, name, passwordHash, normalizeRole(role), enabled ? 1 : 0,
          mustChangePassword ? 1 : 0, approved ? 1 : 0,
          approved ? timestamp : null, approved ? attributed.actorUserId : null,
          timestamp, timestamp
        );
        db.prepare(`
          INSERT INTO audit_events
            (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
          VALUES (?, 'account_created', 'user', ?, ?, ?)
        `).run(
          attributed.actorUserId, id, timestamp,
          JSON.stringify({ loginIdentifier: login, role, ...attributed.audit })
        );
      })();
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error(`An account already exists for ${login}.`);
      }
      throw error;
    }
    return getUserById(id);
  }

  async function register({ loginIdentifier, displayName, password }) {
    const login = normalizeLoginIdentifier(loginIdentifier);
    const name = validateDisplayName(displayName);
    const passwordHash = await hashPassword(password);
    const timestamp = new Date().toISOString();
    const id = crypto.randomUUID();
    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO users
            (id, login_identifier, display_name, password_hash, role, enabled,
             must_change_password, is_system, approved, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'member', 1, 0, 0, 0, ?, ?)
        `).run(id, login, name, passwordHash, timestamp, timestamp);
        db.prepare(`
          INSERT INTO audit_events
            (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
          VALUES (?, 'account_registered', 'user', ?, ?, '{}')
        `).run(id, id, timestamp);
      })();
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error("An account with that login identifier already exists.");
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

  function validateDisplayName(displayName) {
    const name = String(displayName || "").trim();
    if (!name || name.length > 120) {
      throw new Error("Display name is required and must be at most 120 characters.");
    }
    return name;
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

  async function updateOwnProfile(id, displayName, currentPassword) {
    const row = db.prepare("SELECT * FROM users WHERE id=? AND is_system=0 AND enabled=1").get(id);
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
      throw new Error("Current password is incorrect.");
    }
    const name = validateDisplayName(displayName);
    const timestamp = new Date().toISOString();
    db.transaction(() => {
      db.prepare("UPDATE users SET display_name=?, updated_at=? WHERE id=?")
        .run(name, timestamp, id);
      db.prepare(`
        INSERT INTO audit_events
          (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
        VALUES (?, 'profile_updated', 'user', ?, ?, '{}')
      `).run(id, id, timestamp);
    })();
    return getUserById(id);
  }

  function updateIdentity(id, { loginIdentifier, displayName }, operator) {
    const attributed = operatorDetails(operator);
    const current = db.prepare(
      "SELECT login_identifier, display_name FROM users WHERE id=? AND is_system=0"
    ).get(id);
    if (!current) throw new Error("User not found.");
    const login = loginIdentifier === undefined
      ? current.login_identifier : normalizeLoginIdentifier(loginIdentifier);
    const name = displayName === undefined
      ? current.display_name : validateDisplayName(displayName);
    const timestamp = new Date().toISOString();
    try {
      db.transaction(() => {
        db.prepare(`
          UPDATE users SET login_identifier=?, display_name=?, updated_at=? WHERE id=?
        `).run(login, name, timestamp, id);
        db.prepare(`
          INSERT INTO audit_events
            (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
          VALUES (?, 'account_identity_changed', 'user', ?, ?, ?)
        `).run(attributed.actorUserId, id, timestamp, JSON.stringify({
          loginChanged: login !== current.login_identifier,
          displayNameChanged: name !== current.display_name,
          ...attributed.audit
        }));
      })();
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error(`An account already exists for ${login}.`);
      }
      throw error;
    }
    return getUserById(id);
  }

  function setEnabled(id, enabled, operator) {
    const attributed = operatorDetails(operator);
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
        VALUES (?, ?, 'user', ?, ?, ?)
      `).run(
        attributed.actorUserId, enabled ? "account_enabled" : "account_disabled",
        id, timestamp, JSON.stringify(attributed.audit)
      );
    })();
    return getUserById(id);
  }

  function setApproved(id, approved, operator) {
    const attributed = operatorDetails(operator);
    const timestamp = new Date().toISOString();
    db.transaction(() => {
      const current = db.prepare(
        "SELECT role, approved FROM users WHERE id=? AND is_system=0"
      ).get(id);
      if (!current) throw new Error("User not found.");
      if (current.role === "admin" && !approved) {
        throw new Error("Administrator accounts must remain approved.");
      }
      db.prepare(`
        UPDATE users SET approved=?, approved_at=?, approved_by=?, updated_at=? WHERE id=?
      `).run(
        approved ? 1 : 0, approved ? timestamp : null,
        approved ? attributed.actorUserId : null, timestamp, id
      );
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      db.prepare(`
        INSERT INTO audit_events
          (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
        VALUES (?, 'approval_changed', 'user', ?, ?, ?)
      `).run(attributed.actorUserId, id, timestamp, JSON.stringify({
        from: Boolean(current.approved), to: Boolean(approved), ...attributed.audit
      }));
    })();
    return getUserById(id);
  }

  async function resetPassword(
    id, password, { mustChangePassword = true, operator = null } = {}
  ) {
    const attributed = operatorDetails(operator);
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
        VALUES (?, 'password_reset', 'user', ?, ?, ?)
      `).run(
        attributed.actorUserId, id, timestamp,
        JSON.stringify({ mustChangePassword: Boolean(mustChangePassword), ...attributed.audit })
      );
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

  function setRole(id, role, operator) {
    const attributed = operatorDetails(operator);
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
      if (nextRole === "admin") {
        db.prepare(`
          UPDATE users SET approved=1, approved_at=COALESCE(approved_at, ?),
            approved_by=COALESCE(approved_by, ?), updated_at=? WHERE id=?
        `).run(timestamp, attributed.actorUserId, timestamp, id);
      }
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      db.prepare(`
        INSERT INTO audit_events
          (actor_user_id, event_type, entity_type, entity_id, occurred_at, details_json)
        VALUES (?, 'role_changed', 'user', ?, ?, ?)
      `).run(
        attributed.actorUserId, id, timestamp,
        JSON.stringify({ from: current.role, to: nextRole, ...attributed.audit })
      );
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
    register,
    resetPassword,
    setEnabled,
    setApproved,
    setRole,
    updateIdentity,
    updateOwnProfile
  };
}

module.exports = { createUserStore, normalizeLoginIdentifier, normalizeRole };
