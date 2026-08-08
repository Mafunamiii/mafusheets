const fs = require("fs");

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120000;

function getUploadTimeoutMs() {
  const value = Number(process.env.PAPERLESS_UPLOAD_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_UPLOAD_TIMEOUT_MS;
}

class PaperlessError extends Error {
  constructor(message, { code = "PAPERLESS_ERROR", status = null, details = null } = {}) {
    super(message);
    this.name = "PaperlessError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function getConfig() {
  const url = String(process.env.PAPERLESS_URL || "").trim().replace(/\/+$/, "");
  const token = String(process.env.PAPERLESS_API_TOKEN || "").trim();
  const version = String(process.env.PAPERLESS_API_VERSION || "").trim();
  return { url, token, version };
}

async function checkConnectivity() {
  const { url, token, version } = getConfig();
  if (!url || !token || !version) {
    return { configured: false, reachable: false, apiWorking: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${url}/api/documents/?page_size=1`, {
      headers: {
        Accept: `application/json; version=${version}`,
        Authorization: `Token ${token}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        configured: true,
        reachable: true,
        apiWorking: false,
        status: response.status
      };
    }

    return { configured: true, reachable: true, apiWorking: true };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new PaperlessError("Paperless request timed out.", { code: "TIMEOUT" });
    }

    throw new PaperlessError("Paperless could not be reached.", { code: "UNREACHABLE" });
  } finally {
    clearTimeout(timeout);
  }
}

async function listDocuments({ page = 1, pageSize = 25, query = "" } = {}) {
  const { url, token, version } = getConfig();
  if (!url || !token || !version) {
    throw new PaperlessError("Paperless is not configured.", { code: "NOT_CONFIGURED" });
  }

  const boundedPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const boundedPageSize = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 25));
  const searchParams = new URLSearchParams({
    page: String(boundedPage),
    page_size: String(boundedPageSize)
  });
  if (String(query).trim()) searchParams.set("query", String(query).trim());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${url}/api/documents/?${searchParams.toString()}`, {
      headers: {
        Accept: `application/json; version=${version}`,
        Authorization: `Token ${token}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new PaperlessError(`Paperless returned HTTP ${response.status}.`, {
        code: "HTTP_ERROR",
        status: response.status
      });
    }

    return await response.json();
  } catch (error) {
    if (error instanceof PaperlessError) {
      throw error;
    }
    if (error.name === "AbortError") {
      throw new PaperlessError("Paperless request timed out.", { code: "TIMEOUT" });
    }
    throw new PaperlessError("Paperless could not be reached.", { code: "UNREACHABLE" });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(pathname, { method = "GET", body, includeErrorBody = false, expectJson = true } = {}) {
  const { url, token, version } = getConfig();
  if (!url || !token || !version) {
    throw new PaperlessError("Paperless is not configured.", { code: "NOT_CONFIGURED" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers = {
        Accept: `application/json; version=${version}`,
        Authorization: `Token ${token}`
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${url}${pathname}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    if (!response.ok) {
      let details = null;
      if (includeErrorBody) {
        try {
          const parsed = await response.json();
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed;
        } catch {
          // The upstream may return an empty or non-JSON error body.
        }
      }
      throw new PaperlessError(`Paperless returned HTTP ${response.status}.`, {
        code: "HTTP_ERROR",
        status: response.status,
        details
      });
    }
    return expectJson && response.status !== 204 ? await response.json() : null;
  } catch (error) {
    if (error instanceof PaperlessError) throw error;
    if (error.name === "AbortError") {
      throw new PaperlessError("Paperless request timed out.", { code: "TIMEOUT" });
    }
    throw new PaperlessError("Paperless could not be reached.", { code: "UNREACHABLE" });
  } finally {
    clearTimeout(timeout);
  }
}

async function listAll(pathname) {
  const results = [];
  let next = `${pathname}?page_size=100`;
  while (next) {
    const response = await requestJson(next);
    if (Array.isArray(response.results)) results.push(...response.results);
    next = response.next ? new URL(response.next).pathname + new URL(response.next).search : null;
  }
  return results;
}

async function getMetadataLookups() {
  const [correspondents, tags, documentTypes, customFields] = await Promise.all([
    listAll("/api/correspondents/"),
    listAll("/api/tags/"),
    listAll("/api/document_types/"),
    listAll("/api/custom_fields/")
  ]);
  return { correspondents, tags, documentTypes, customFields };
}

async function getDocumentFile(documentId, { kind = "archive" } = {}) {
  const { url, token, version } = getConfig();
  if (!url || !token || !version) {
    throw new PaperlessError("Paperless is not configured.", { code: "NOT_CONFIGURED" });
  }

  const id = encodeURIComponent(String(documentId));
  const endpoints = {
    original: `/api/documents/${id}/download/?original=1`,
    archive: `/api/documents/${id}/download/`,
    preview: `/api/documents/${id}/preview/`,
    thumbnail: `/api/documents/${id}/thumb/`
  };
  const pathname = endpoints[kind];
  if (!pathname) {
    throw new PaperlessError("Unsupported Paperless file type.", { code: "INVALID_FILE_TYPE" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}${pathname}`, {
      headers: {
        Accept: `*/*; version=${version}`,
        Authorization: `Token ${token}`
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new PaperlessError(`Paperless returned HTTP ${response.status}.`, {
        code: "HTTP_ERROR",
        status: response.status
      });
    }
    return response;
  } catch (error) {
    if (error instanceof PaperlessError) throw error;
    if (error.name === "AbortError") {
      throw new PaperlessError("Paperless request timed out.", { code: "TIMEOUT" });
    }
    throw new PaperlessError("Paperless could not be reached.", { code: "UNREACHABLE" });
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadDocument({ filePath, filename, contentType, title, artist, tags, sheetKind, key, capo, bpm, notes, lookups }) {
  const { url, token, version } = getConfig();
  if (!url || !token || !version) {
    throw new PaperlessError("Paperless is not configured.", { code: "NOT_CONFIGURED" });
  }

  const findId = (items, value) => {
    const wanted = String(value || "").trim().toLowerCase();
    return (items || []).find((item) => String(item.name || "").trim().toLowerCase() === wanted)?.id;
  };
  const correspondent = findId(lookups.correspondents, artist);
  const documentType = findId(lookups.documentTypes, sheetKind);
  const tagIds = (tags || []).map((tag) => findId(lookups.tags, tag)).filter((id) => id !== undefined);
  const customFields = [];
  for (const [name, value] of [["Key", key], ["Capo", capo], ["BPM", bpm], ["Notes", notes]]) {
    if (value === null || value === undefined || value === "") continue;
    const field = (lookups.customFields || []).find((item) => String(item.name || "").trim().toLowerCase() === name.toLowerCase());
    if (field) customFields.push({ field: field.id, value });
  }

  const form = new FormData();
  form.append("document", new Blob([fs.readFileSync(filePath)], { type: contentType || "application/octet-stream" }), filename);
  form.append("title", title);
  if (correspondent !== undefined) form.append("correspondent", String(correspondent));
  if (documentType !== undefined) form.append("document_type", String(documentType));
  if (tagIds.length) form.append("tags", JSON.stringify(tagIds));
  if (customFields.length) form.append("custom_fields", JSON.stringify(customFields));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getUploadTimeoutMs());
  try {
    const response = await fetch(`${url}/api/documents/post_document/`, {
      method: "POST",
      headers: { Accept: `application/json; version=${version}`, Authorization: `Token ${token}` },
      body: form,
      signal: controller.signal
    });
    if (!response.ok) throw new PaperlessError(`Paperless returned HTTP ${response.status}.`, { code: "HTTP_ERROR", status: response.status });
    return await response.json();
  } catch (error) {
    if (error instanceof PaperlessError) throw error;
    if (error.name === "AbortError") throw new PaperlessError("Paperless request timed out.", { code: "TIMEOUT" });
    throw new PaperlessError("Paperless upload failed.", { code: "UNREACHABLE" });
  } finally {
    clearTimeout(timeout);
  }
}

async function updateDocumentMetadata({ documentId, title, artist, tags, sheetKind, key, capo, bpm, notes, lookups, updateSheetKind = false }) {
  const id = encodeURIComponent(String(documentId));
  const current = await requestJson(`/api/documents/${id}/`);
  const findId = (items, value) => {
    const wanted = String(value || "").trim().toLowerCase();
    return (items || []).find((item) => String(item.name || "").trim().toLowerCase() === wanted)?.id;
  };

  const validationError = (message) => {
    throw new PaperlessError(message, { code: "VALIDATION_ERROR", status: 400 });
  };
  const correspondent = artist ? findId(lookups.correspondents, artist) : null;
  if (artist && correspondent === undefined) validationError(`Paperless correspondent does not exist: ${artist}`);
  const documentType = sheetKind ? findId(lookups.documentTypes, sheetKind) : null;
  if (updateSheetKind && sheetKind && documentType === undefined) validationError(`Paperless document type does not exist: ${sheetKind}`);
  const tagIds = (tags || []).map((tag) => {
    const tagId = findId(lookups.tags, tag);
    if (tagId === undefined) validationError(`Paperless tag does not exist: ${tag}`);
    return tagId;
  });
  const customFieldByName = new Map((lookups.customFields || []).map((field) => [String(field.name || "").trim().toLowerCase(), field]));
  const mappedCustomFields = new Set(["key", "capo", "bpm", "notes"]);
  const customFields = (Array.isArray(current.custom_fields) ? current.custom_fields : []).filter((entry) => {
    const field = (lookups.customFields || []).find((item) => String(item.id) === String(entry.field ?? entry.field_id));
    return !field || !mappedCustomFields.has(String(field.name || "").trim().toLowerCase());
  });

  const typedCustomValue = (field, value) => {
    if (value === null || value === undefined || value === "") return value;
    const dataType = String(field.data_type || "").toLowerCase();
    if (["integer", "int"].includes(dataType)) {
      const parsed = Number.parseInt(String(value), 10);
      if (!Number.isInteger(parsed)) validationError(`Paperless custom field ${field.name} requires an integer.`);
      return parsed;
    }
    if (dataType === "float") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) validationError(`Paperless custom field ${field.name} requires a number.`);
      return parsed;
    }
    if (dataType === "boolean") return value === true || String(value).toLowerCase() === "true";
    if (dataType === "select") {
      const options = field.extra_data?.select_options || [];
      const option = options.find((item) => String(item.id) === String(value) || String(item.label || "").trim().toLowerCase() === String(value).trim().toLowerCase());
      if (!option) validationError(`Paperless custom field ${field.name} has no option matching: ${value}`);
      return option.id;
    }
    return String(value);
  };

  for (const [name, value] of [["Key", key], ["Capo", capo], ["BPM", bpm], ["Notes", notes]]) {
    const field = customFieldByName.get(name.toLowerCase());
    if (!field) validationError(`Paperless custom field does not exist: ${name}`);
    if (value !== null && value !== undefined && value !== "") {
      customFields.push({ field: field.id, value: typedCustomValue(field, value) });
    }
  }

  const payload = {
    title,
    correspondent: correspondent === undefined ? null : correspondent,
    tags: tagIds,
    custom_fields: customFields
  };
  if (updateSheetKind) payload.document_type = documentType === undefined ? null : documentType;
  return requestJson(`/api/documents/${id}/`, { method: "PATCH", body: payload, includeErrorBody: true });
}

async function deleteDocument({ documentId }) {
  const id = encodeURIComponent(String(documentId));
  await requestJson(`/api/documents/${id}/`, { method: "DELETE", expectJson: false });
}

module.exports = { PaperlessError, checkConnectivity, listDocuments, getMetadataLookups, getDocumentFile, uploadDocument, updateDocumentMetadata, deleteDocument };
