const path = require("path");
const { extractSearchText } = require("./search-indexer");
const {
  MIGRATION_ACTOR_ID,
  createCatalogStore,
  migrateLegacyCatalog,
  openDatabase
} = require("./lib/database");

const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "data", "resources.json");
const DATABASE_FILE = process.env.DATABASE_PATH || path.join(ROOT, "data", "mafusheets.sqlite");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const FORCE_ALL = process.argv.includes("--all");

async function main() {
  const db = openDatabase(DATABASE_FILE);
  await migrateLegacyCatalog(db, INDEX_FILE);
  const catalog = createCatalogStore(db);
  const resources = catalog.listResources();
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

  catalog.replaceResources(resources, MIGRATION_ACTOR_ID);
  console.log(`Done. Indexed ${indexed}, skipped ${skipped}.`);
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
