"use strict";

const { test, expect } = require("@playwright/test");
const JSZip = require("jszip");

async function login(page, username = "member@example.test", password = "MemberPassword2026") {
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL("**/"),
    page.getByRole("button", { name: "Sign in" }).click()
  ]);
  await expect(page.locator("#resourceGrid")).not.toHaveAttribute("aria-busy", "true");
}

test("unauthenticated login page and successful normal login", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "MafuSheets" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("#resourceGrid")).toHaveCount(0);
  await login(page);
  await expect(page.getByText("Member sheet", { exact: true })).toBeVisible();
});

test("forced password change blocks the library and preserves the authenticated session", async (
  { page }, testInfo
) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "state-changing flow runs once");
  await page.goto("/");
  await page.getByLabel("Username").fill("forced@example.test");
  await page.getByLabel("Password").fill("TemporaryPassword2026");
  await Promise.all([
    page.waitForURL("**/"),
    page.getByRole("button", { name: "Sign in" }).click()
  ]);
  const dialog = page.locator("#passwordChangeDialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("open", "");
  await page.locator("#currentPasswordInput").fill("TemporaryPassword2026");
  await page.locator("#newPasswordInput").fill("ChangedPassword2026");
  await page.locator("#confirmPasswordInput").fill("ChangedPassword2026");
  await page.locator("#passwordChangeButton").click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("Member sheet", { exact: true })).toBeVisible();
});

test("member/admin differences and owner/non-owner editing", async ({ page }) => {
  await login(page);
  await page.locator('[data-resource-id="member-sheet"] [data-open]').first().click();
  await expect(page.locator("#detailTitleInput")).toBeEnabled();
  await expect(page.locator("#detailDeleteButton")).toBeHidden();
  await page.locator("#closeDialog").click();
  await page.locator('[data-resource-id="other-sheet"] [data-open]').first().click();
  await expect(page.locator("#detailTitleInput")).toBeDisabled();

  await page.context().clearCookies();
  await login(page, "admin@example.test", "AdminPassword2026");
  await page.locator("#accountButton").click();
  await expect(page.locator("#refreshThumbsButton")).toBeVisible();
  await page.locator("#closeActions").click();
  await page.locator('[data-resource-id="other-sheet"] [data-open]').first().click();
  await expect(page.locator("#detailTitleInput")).toBeEnabled();
  await expect(page.locator("#detailDeleteButton")).toBeVisible();
});

test("upload modal focus, Escape behavior, and essential dialog keyboard access", async ({ page }) => {
  await login(page);
  await page.locator("#addSheetButton").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#actionsDialog")).toBeVisible();
  await expect(page.locator("#titleInput")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#artistInput")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#actionsDialog")).not.toBeVisible();
  await page.locator('[data-resource-id="member-sheet"] [data-open]').first().click();
  await expect(page.locator("#sheetDialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#sheetDialog")).not.toBeVisible();
});

test("mobile viewport remains library-first", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-mobile", "mobile project assertion");
  await login(page);
  const library = await page.locator("section.panel.library").boundingBox();
  const actions = await page.locator("#actionsDialog").boundingBox();
  expect(library).not.toBeNull();
  expect(actions).toBeNull();
  await expect(page.getByText("Member sheet", { exact: true })).toBeVisible();
});

test("mobile PDF reader scrolls all pages and spaces actions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-mobile", "mobile project assertion");
  await login(page);
  await page.goto("/sheets/pdf-sheet");
  await expect(page.getByRole("link", { name: "Open in new tab" })).toBeVisible();
  await expect(page.locator(".pdf-page")).toHaveCount(2);
  const open = await page.getByRole("link", { name: "Open in new tab" }).boundingBox();
  const download = await page.getByRole("link", { name: "Download" }).boundingBox();
  expect(open).not.toBeNull();
  expect(download).not.toBeNull();
  expect(download.y).toBe(open.y);
  expect(download.x - (open.x + open.width)).toBeGreaterThanOrEqual(8);
  await page.locator(".pdf-page").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".pdf-page").last()).toBeInViewport();
});

test("page-aware search opens a PDF at the matching page", async ({ page }) => {
  await login(page);
  await page.getByLabel("Search sheets").fill("hidden refrain");
  const result = page.locator('[data-resource-id="pdf-sheet"]');
  await expect(result).toBeVisible();
  const open = result.getByRole("link", { name: "Open page 2" });
  await expect(open).toHaveAttribute("href", "/sheets/pdf-sheet?page=2");
  await open.click();
  await expect(page).toHaveURL(/\/sheets\/pdf-sheet\?page=2$/);
  await expect(page.getByRole("link", { name: "Open in new tab" }))
    .toHaveAttribute("href", /\/api\/resources\/pdf-sheet\/view#page=2$/);
});

test("admin can download an uploaded-files backup", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "backup flow runs once");
  await login(page, "admin@example.test", "AdminPassword2026");
  const response = await page.request.get("/api/admin/uploads-backup.zip");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/zip");
  const zip = await JSZip.loadAsync(await response.body());
  expect(zip.file("backup-manifest.json")).not.toBeNull();
  expect(zip.file("uploads/pdf-sheet/two-pages.pdf")).not.toBeNull();
  const manifest = JSON.parse(await zip.file("backup-manifest.json").async("string"));
  expect(manifest.format).toBe("mafusheets-upload-backup-v1");
  expect(manifest.resources.some((resource) => resource.id === "pdf-sheet")).toBe(true);
});

test("compact list mode makes no thumbnail requests", async ({ page }) => {
  await login(page);
  let thumbnails = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/thumbnails/")) thumbnails += 1;
  });
  await page.goto("/?view=list");
  await expect(page.locator("#resourceGrid")).toHaveClass(/list-view/);
  await page.waitForTimeout(200);
  expect(thumbnails).toBe(0);
  await expect(page.locator("#resourceGrid img[data-thumbnail]")).toHaveCount(0);
});

test("grid thumbnail failure displays a placeholder", async ({ page }) => {
  await page.route("**/thumbnails/*.png", (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "failed" })
  );
  await login(page);
  await expect(page.locator(".thumbnail-placeholder").first()).toContainText("Thumbnail unavailable");
});

test("catalog failure is distinct from empty and Retry recovers", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/resources?**", async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({
        status: 500, contentType: "application/json", body: JSON.stringify({ error: "Catalog failed" })
      });
    } else {
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ resources: [], total: 0 })
      });
    }
  });
  await login(page);
  await expect(page.getByText("Catalog failed")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("The library is empty.")).toBeVisible();
});

test("session expiration preserves unsaved non-secret upload values", async ({ page }) => {
  await login(page);
  await page.locator("#addSheetButton").click();
  await page.locator("#titleInput").fill("Unsaved rehearsal title");
  await page.route("**/api/resources*", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"expired"}' })
  );
  await page.evaluate("apiFetch('/api/resources')");
  await expect(page.locator("#loginMessage")).toContainText("unsaved form values were kept");
  await page.locator('[data-side-tab="add"]').click();
  await expect(page.locator("#titleInput")).toHaveValue("Unsaved rehearsal title");
});

test("failed metadata update retains edits", async ({ page }) => {
  await login(page);
  await page.route("**/api/resources/member-sheet", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Update failed"}' });
    } else {
      await route.continue();
    }
  });
  await page.locator('[data-resource-id="member-sheet"] [data-open]').first().click();
  await page.locator("#detailTitleInput").fill("Retained edit");
  await page.locator("#detailForm button[type=submit]").click();
  await expect(page.locator("#detailMessage")).toContainText("Update failed");
  await expect(page.locator("#detailTitleInput")).toHaveValue("Retained edit");
});

test("deletion confirmation and failure retain the resource", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "desktop pointer confirmation coverage");
  await login(page, "admin@example.test", "AdminPassword2026");
  await page.route("**/api/resources/other-sheet", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Deletion failed"}' });
    } else {
      await route.continue();
    }
  });
  await page.locator('[data-resource-id="other-sheet"] [data-open]').first().click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#detailDeleteButton").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#detailMessage")).toContainText("remains visible");
  await expect(page.locator("#sheetDialog")).toBeVisible();
  await page.locator("#closeDialog").click();
  await expect(page.locator('[data-resource-id="other-sheet"]')).toBeVisible();
});
