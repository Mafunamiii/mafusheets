const fsp = require("fs/promises");
const path = require("path");
const { extractSearchText } = require("./search-indexer");

const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "data", "resources.json");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const FORCE_ALL = process.argv.includes("--all");

async function readIndex() {
  const raw = await fsp.readFile(INDEX_FILE, "utf8");
  const resources = JSON.parse(raw || "[]");
  return Array.isArray(resources) ? resources : [];
}

async function writeIndex(resources) {
  const tmpFile = `${INDEX_FILE}.tmp`;
  await fsp.writeFile(tmpFile, `${JSON.stringify(resources, null, 2)}\n`, "utf8");
  await fsp.rename(tmpFile, INDEX_FILE);
}

async function main() {
  const resources = await readIndex();
  let indexed = 0;
  let skipped = 0;

  for (const resource of resources) {
    if (!FORCE_ALL && typeof resource.searchText === "string") {
      skipped += 1;
      continue;
    }

    const filePath = path.join(UPLOADS_DIR, resource.category, resource.storedName);
    const result = await extractSearchText(filePath, resource.extension);
    resource.searchText = result.searchText;
    resource.searchStatus = result.searchStatus;
    resource.indexedAt = new Date().toISOString();
    resource.sheetKind = resource.sheetKind || (resource.extension === ".pdf" ? "pdf" : [".png", ".jpg", ".jpeg"].includes(resource.extension) ? "image" : [".txt", ".md", ".docx"].includes(resource.extension) ? "chart" : "other");
    if (!Array.isArray(resource.tags)) {
      resource.tags = [];
    }
    if (!Array.isArray(resource.annotations)) {
      resource.annotations = [];
    }
    indexed += 1;
    console.log(`${resource.searchStatus}: ${resource.originalName}`);
  }

  await writeIndex(resources);
  console.log(`Done. Indexed ${indexed}, skipped ${skipped}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
