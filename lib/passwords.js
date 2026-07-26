"use strict";

const bcrypt = require("bcryptjs");

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 72;

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_BYTES} UTF-8 bytes.`);
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new Error("Password must include uppercase, lowercase, and numeric characters.");
  }
  return value;
}

async function hashPassword(password) {
  return bcrypt.hash(validatePassword(password), BCRYPT_COST);
}

async function verifyPassword(password, passwordHash) {
  if (!passwordHash || typeof passwordHash !== "string") {
    return false;
  }
  return bcrypt.compare(String(password || ""), passwordHash);
}

module.exports = {
  BCRYPT_COST,
  hashPassword,
  validatePassword,
  verifyPassword
};
