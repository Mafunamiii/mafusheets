const path = require("path");
const { extractSearchText } = require("./search-indexer");
const {
  MIGRATION_ACTOR_ID,
  createCatalogStore,
  migrateLegacyCatalog,
  openDatabase
} = require("./lib/database");
const { createResourceStore } = require("./lib/resources");

const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "data", "resources.json");
const DATABASE_FILE = process.env.DATABASE_PATH || path.join(ROOT, "data", "mafusheets.sqlite");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const FORCE_ALL = process.argv.includes("--all");

async function main() {
  const db = openDatabase(DATABASE_FILE);
  await migrateLegacyCatalog(db, INDEX_FILE);
  const catalog = createCatalogStore(db);
  const resourceStore = createResourceStore(db);
  const resources = catalog.listResources();
  let indexed = 0;
  let skipped = 0;

  for (const resource of resources) {
    if (!FORCE_ALL && resource.indexedAt && resource.searchStatus !== "failed") {
      skipped += 1;
      continue;
    }

    const filePath = path.join(UPLOADS_DIR, resource.category, resource.storedName);
    const result = await extractSearchText(filePath, resource.extension);
    const committed = resourceStore.updateSearchIndex(
      resource.id, resource.updatedAt, result, MIGRATION_ACTOR_ID
    );
    if (committed) {
      indexed += 1;
      console.log(`${result.searchStatus}: ${resource.originalName}`);
    } else {
      skipped += 1;
      console.log(`conflict: ${resource.originalName}`);
    }
  }
  console.log(`Done. Indexed ${indexed}, skipped ${skipped}.`);
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
