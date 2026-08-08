const fsp = require("fs/promises");
const path = require("path");
const JSZip = require("jszip");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");

const MAX_SEARCH_TEXT_LENGTH = 500000;

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SEARCH_TEXT_LENGTH);
}

function stripXmlText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function extractPptxText(filePath) {
  const buffer = await fsp.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const text = [];

  for (const name of slideFiles) {
    const xml = await zip.files[name].async("text");
    text.push(stripXmlText(xml));
  }

  return text.join(" ");
}

async function extractPlainTextFile(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");

  if (/\.(html?|xhtml)$/i.test(filePath)) {
    return stripXmlText(raw);
  }

  return raw;
}

async function extractPdfPageText(pageData, pages) {
  const content = await pageData.getTextContent();
  const pageText = content.items.map((item) => item.str || "").join(" ");
  const pageNumber = Number(pageData.pageNumber) || pages.length + 1;
  pages[pageNumber - 1] = normalizeSearchText(pageText);
  return pageText;
}

async function extractSearchText(filePath, extension) {
  try {
    let text = "";
    let searchPages = [];

    if (extension === ".pdf") {
      const buffer = await fsp.readFile(filePath);
      const pages = [];
      const parsed = await pdfParse(buffer, {
        pagerender: (pageData) => extractPdfPageText(pageData, pages)
      });
      text = parsed.text || "";
      searchPages = pages.map((page) => page || "");
    } else if (extension === ".docx") {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value || "";
    } else if (extension === ".pptx") {
      text = await extractPptxText(filePath);
    } else if ([".txt", ".md", ".html", ".htm"].includes(extension)) {
      text = await extractPlainTextFile(filePath);
    }

    return {
      searchText: normalizeSearchText(text),
      searchPages,
      searchStatus: text ? "indexed" : "empty"
    };
  } catch (error) {
    console.warn(`Search indexing failed for ${path.basename(filePath)}: ${error.message}`);
    return {
      searchText: "",
      searchPages: [],
      searchStatus: "failed"
    };
  }
}

module.exports = {
  extractPdfPageText,
  extractSearchText,
  normalizeSearchText
};
