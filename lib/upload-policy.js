"use strict";

const fsp = require("fs/promises");
const path = require("path");

const MIME_BY_EXTENSION = {
  ".pdf": new Set(["application/pdf"]),
  ".png": new Set(["image/png"]),
  ".jpg": new Set(["image/jpeg", "image/pjpeg"]),
  ".jpeg": new Set(["image/jpeg", "image/pjpeg"]),
  ".txt": new Set(["text/plain", "application/octet-stream"]),
  ".md": new Set(["text/markdown", "text/plain", "application/octet-stream"]),
  ".docx": new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/octet-stream"
  ])
};

const CONFUSING_EXTENSIONS = new Set([
  ".bat", ".cmd", ".com", ".exe", ".html", ".htm", ".js", ".jar", ".msi",
  ".php", ".ps1", ".sh", ".svg"
]);

class UploadPolicyError extends Error {
  constructor(message, status = 400, code = "UPLOAD_POLICY") {
    super(message);
    this.name = "UploadPolicyError";
    this.status = status;
    this.code = code;
  }
}

function normalizeFilename(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new UploadPolicyError("The filename contains unsupported characters.");
  }
  const normalized = raw.normalize("NFKC").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 180) {
    throw new UploadPolicyError("The filename is empty or too long.");
  }
  if (
    path.isAbsolute(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    path.basename(normalized) !== normalized ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new UploadPolicyError("The filename must not contain a path.");
  }
  const extension = path.extname(normalized).toLowerCase();
  const stem = normalized.slice(0, -extension.length);
  if (!extension || !stem || CONFUSING_EXTENSIONS.has(path.extname(stem).toLowerCase())) {
    throw new UploadPolicyError("The filename has a confusing or unsupported extension.");
  }
  return { originalName: normalized, extension };
}

function validateDeclaredMime(extension, mimetype) {
  const declared = String(mimetype || "").toLowerCase().split(";")[0].trim();
  const allowed = MIME_BY_EXTENSION[extension];
  if (!allowed || !allowed.has(declared)) {
    throw new UploadPolicyError(
      `The declared file type does not match ${extension}.`,
      400,
      "MIME_MISMATCH"
    );
  }
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return null;
}

async function validateSignature(filePath, extension, { maxImagePixels }) {
  const handle = await fsp.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new UploadPolicyError("The staged upload is not a regular file.");
    const headSize = Math.min(stat.size, 1024 * 1024);
    const head = Buffer.alloc(headSize);
    await handle.read(head, 0, headSize, 0);

    if (extension === ".pdf") {
      if (head.length < 8 || head.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new UploadPolicyError("The file does not have a valid PDF signature.", 400, "BAD_SIGNATURE");
      }
      const tailSize = Math.min(stat.size, 4096);
      const tail = Buffer.alloc(tailSize);
      await handle.read(tail, 0, tailSize, stat.size - tailSize);
      if (!tail.includes(Buffer.from("%%EOF"))) {
        throw new UploadPolicyError("The PDF is incomplete or malformed.", 400, "BAD_SIGNATURE");
      }
      if (head.includes(Buffer.from("/Encrypt")) || tail.includes(Buffer.from("/Encrypt"))) {
        throw new UploadPolicyError("Encrypted PDFs are not supported.", 400, "ENCRYPTED_PDF");
      }
      return;
    }

    if (extension === ".png") {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (head.length < 24 || !head.subarray(0, 8).equals(png) || head.toString("ascii", 12, 16) !== "IHDR") {
        throw new UploadPolicyError("The file does not have a valid PNG signature.", 400, "BAD_SIGNATURE");
      }
      const width = head.readUInt32BE(16);
      const height = head.readUInt32BE(20);
      if (!width || !height || width * height > maxImagePixels) {
        throw new UploadPolicyError("The image dimensions exceed the configured pixel limit.", 400, "IMAGE_DIMENSIONS");
      }
      return;
    }

    if (extension === ".jpg" || extension === ".jpeg") {
      if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) {
        throw new UploadPolicyError("The file does not have a valid JPEG signature.", 400, "BAD_SIGNATURE");
      }
      const dimensions = jpegDimensions(head);
      if (!dimensions || dimensions.width * dimensions.height > maxImagePixels) {
        throw new UploadPolicyError("The image is malformed or exceeds the pixel limit.", 400, "IMAGE_DIMENSIONS");
      }
      return;
    }

    if (extension === ".docx") {
      if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) {
        throw new UploadPolicyError("The file does not have a valid DOCX/ZIP signature.", 400, "BAD_SIGNATURE");
      }
      return;
    }

    if (extension === ".txt" || extension === ".md") {
      if (head.includes(Buffer.from([0]))) {
        throw new UploadPolicyError("Text uploads must not contain binary null bytes.", 400, "BAD_SIGNATURE");
      }
      return;
    }

    throw new UploadPolicyError("This file format is not supported.");
  } finally {
    await handle.close();
  }
}

module.exports = {
  UploadPolicyError,
  normalizeFilename,
  validateDeclaredMime,
  validateSignature
};
