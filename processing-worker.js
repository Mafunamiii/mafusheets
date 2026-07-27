"use strict";

const { execFile } = require("child_process");
const fsp = require("fs/promises");
const { promisify } = require("util");
const JSZip = require("jszip");
const sharp = require("sharp");
const { extractSearchText } = require("./search-indexer");

const execFileAsync = promisify(execFile);

function send(message) {
  if (process.send) process.send(message);
}

async function validateDocx(filePath, limits) {
  const data = await fsp.readFile(filePath);
  const zip = await JSZip.loadAsync(data, { checkCRC32: true });
  const entries = Object.values(zip.files);
  if (entries.length > limits.maxArchiveEntries) throw new Error("DOCX_ARCHIVE_ENTRIES");
  let expanded = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const bytes = await entry.async("uint8array");
    expanded += bytes.byteLength;
    if (expanded > limits.maxArchiveExpandedBytes) throw new Error("DOCX_ARCHIVE_EXPANDED");
  }
  if (!zip.file("[Content_Types].xml") || !zip.file("word/document.xml")) {
    throw new Error("DOCX_STRUCTURE");
  }
}

async function validatePdf(filePath, limits) {
  const { stdout } = await execFileAsync(limits.pdfInfoBin, [filePath], {
    timeout: limits.processTimeoutMs,
    maxBuffer: limits.childOutputBytes,
    windowsHide: true,
    shell: false,
    killSignal: "SIGKILL"
  });
  const pages = Number((String(stdout).match(/^Pages:\s+(\d+)/m) || [])[1]);
  const encrypted = (String(stdout).match(/^Encrypted:\s+(\S+)/m) || [])[1];
  if (encrypted && encrypted.toLowerCase() !== "no") throw new Error("PDF_ENCRYPTED");
  if (!Number.isInteger(pages) || pages < 1 || pages > limits.maxPdfPages) {
    throw new Error("PDF_PAGE_LIMIT");
  }
}

async function validateImage(filePath, limits) {
  const metadata = await sharp(filePath, {
    failOn: "error",
    limitInputPixels: limits.maxImagePixels,
    unlimited: false,
    sequentialRead: true
  }).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > limits.maxImagePixels) {
    throw new Error("IMAGE_PIXEL_LIMIT");
  }
  if (!["png", "jpeg"].includes(metadata.format)) throw new Error("IMAGE_FORMAT");
}

async function validate(message) {
  const { extension, filePath, limits } = message;
  if (extension === ".pdf") await validatePdf(filePath, limits);
  else if ([".png", ".jpg", ".jpeg"].includes(extension)) await validateImage(filePath, limits);
  else if (extension === ".docx") await validateDocx(filePath, limits);
}

async function processResource(message) {
  const { extension, filePath, thumbnailPath, limits } = message;
  const index = await extractSearchText(filePath, extension);
  let generatedThumbnail = null;
  if (extension === ".pdf") {
    const prefix = `${thumbnailPath}.worker`;
    await execFileAsync(limits.pdfToPpmBin, [
      "-f", "1", "-l", "1", "-png", "-singlefile",
      "-scale-to-x", "520", "-scale-to-y", "-1", filePath, prefix
    ], {
      timeout: limits.processTimeoutMs,
      maxBuffer: limits.childOutputBytes,
      windowsHide: true,
      shell: false,
      killSignal: "SIGKILL"
    });
    generatedThumbnail = `${prefix}.png`;
  } else if ([".png", ".jpg", ".jpeg"].includes(extension)) {
    generatedThumbnail = `${thumbnailPath}.worker.png`;
    await sharp(filePath, {
      failOn: "error",
      limitInputPixels: limits.maxImagePixels,
      unlimited: false,
      sequentialRead: true
    }).rotate().resize({ width: 520, height: 720, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 8 }).toFile(generatedThumbnail);
  }
  return { ...index, generatedThumbnail };
}

process.once("message", async (message) => {
  /** @type {any} */
  const request = message;
  try {
    const result = request.action === "validate"
      ? await validate(request)
      : await processResource(request);
    send({ ok: true, result });
    process.exit(0);
  } catch (error) {
    send({
      ok: false,
      error: String(error && error.message || error).replace(/[^\w .:-]/g, "").slice(0, 240)
    });
    process.exit(1);
  }
});
