"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

async function source() {
  return fsp.readFile(path.join(ROOT, "server.js"), "utf8");
}

test("mobile browsing is library-first and upload is an accessible on-demand dialog", async () => {
  const text = await source();
  const library = text.indexOf('<section class="panel library">');
  const actions = text.indexOf('<dialog class="actions-dialog" id="actionsDialog"');
  assert.ok(library > 0 && actions > library, "library must precede actions in DOM order");
  assert.match(text, /id="addSheetButton"[^>]*>Add sheet</);
  assert.match(text, /actionsDialog\.showModal\(\)/);
  assert.match(text, /id="closeActions"[^>]*aria-label="Close library actions"/);
  assert.match(text, /@media \(max-width: 640px\)[\s\S]*?\.hero-card \{ height: 150px; \}/);
});

test("compact list mode creates no thumbnail or preview element", async () => {
  const text = await source();
  assert.match(text, /const previewWrap = state\.viewMode === "list" \? "" :/);
  assert.match(text, /\.resource-grid\.list-view \.card[\s\S]*?min-height: 52px/);
  assert.match(text, /data-thumbnail/);
  assert.match(text, /Thumbnail unavailable/);
});

test("catalog failures remain distinct from valid empty results and are retryable", async () => {
  const text = await source();
  assert.match(text, /catalogStatus: "loading"/);
  assert.match(text, /state\.catalogStatus = "network"/);
  assert.match(text, /state\.catalogStatus = "authentication"/);
  assert.match(text, /state\.catalogStatus = "authorization"/);
  assert.match(text, /if \(state\.catalogStatus !== "ready"\)/);
  assert.match(text, /data-retry-catalog/);
  assert.match(text, /The library is empty\./);
});

test("role controls and recoverable mutations do not replace server authorization", async () => {
  const text = await source();
  assert.match(text, /body:not\(\[data-role="admin"\]\) \.admin-only/);
  assert.match(text, /authState\.role === "admin" \|\| resource\.uploadedBy === authState\.userId/);
  assert.match(text, /requireAdmin, requireSameOrigin, requireCsrf/);
  assert.match(text, /detailDeleteButton\.disabled = true/);
  assert.match(text, /The sheet remains visible/);
  assert.match(text, /Selected files:/);
  assert.match(text, /unsaved form values were kept/);
});

test("search, filter, view, history, and scroll state are preserved", async () => {
  const text = await source();
  assert.match(text, /url\.searchParams\.set\("kind", state\.activeTab\)/);
  assert.match(text, /url\.searchParams\.set\("q", state\.query\)/);
  assert.match(text, /url\.searchParams\.set\("view", state\.viewMode\)/);
  assert.match(text, /window\.addEventListener\("popstate"/);
  assert.match(text, /sessionStorage\.setItem\("mafusheets\.scrollY"/);
  assert.match(text, /window\.scrollTo\(0, savedScroll\)/);
});
