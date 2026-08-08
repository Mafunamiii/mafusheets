"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { extractPdfPageText } = require("../search-indexer");

test("PDF indexing retains normalized text at the source page number", async () => {
  const pages = [];
  const pageText = await extractPdfPageText({
    pageNumber: 2,
    getTextContent: async () => ({
      items: [{ str: "Hidden" }, { str: "REFRAIN" }, { str: "" }]
    })
  }, pages);

  assert.equal(pageText, "Hidden REFRAIN ");
  assert.equal(pages.length, 2);
  assert.equal(pages[0], undefined);
  assert.equal(pages[1], "hidden refrain");
});
