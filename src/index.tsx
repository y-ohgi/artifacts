import { Hono } from "hono";

import { serveArtifact } from "./artifacts/serve";
import { MAX_SIZE_BYTES, storeArtifact } from "./artifacts/upload";
import { isSameOriginRequest, resolveOwner, type OwnerResolution } from "./auth";
import { listArtifacts, updateVisibility, type ArtifactListItem, type Visibility } from "./db";
import type { AppEnv } from "./env";
import { ErrorCodes, errorResponse } from "./errors";
import { adminHeaderRecord } from "./headers";
import { ListPage } from "./views/list";
import { PATH_LIST, PATH_UPLOAD } from "./views/layout";
import type { ArtifactListItem as ViewArtifactListItem } from "./views/types";
import { UploadPage, type UploadError } from "./views/upload";

const app = new Hono<{ Bindings: AppEnv }>();

/**
 * Reserved prefixes. uid is lowercase alphanumeric only (FR-034), so nothing
 * starting with `_` can ever collide with a uid namespace — which is why the
 * management UI lives under `/_app` and needs no reserved-word list.
 *
 * Access protects `/_app/*`; `/<uid>/<name>` is deliberately left unprotected so
 * that the Worker itself decides visibility per artifact.
 */
const API_ARTIFACTS = "/_app/api/artifacts";

/** Sends the shared security headers on every management response. */
app.use("/_app/*", async (c, next) => {
  await next();
  for (const [key, value] of Object.entries(adminHeaderRecord())) {
    c.res.headers.set(key, value);
  }
});

app.get("/", (c) => c.redirect(PATH_LIST, 302));

// --- management UI -----------------------------------------------------------

app.get("/_app/", async (c) => {
  const owner = await resolveOwner(c.env, c.req.raw);
  if (!owner.ok) {
    return ownerRejection(owner);
  }

  const artifacts = await listArtifacts(c.env.DB, owner.uid);
  return c.html(<ListPage artifacts={artifacts.map((row) => toViewItem(c.req.url, owner.uid, row))} />);
});

app.get("/_app/upload", async (c) => {
  const owner = await resolveOwner(c.env, c.req.raw);
  if (!owner.ok) {
    return ownerRejection(owner);
  }

  return c.html(<UploadPage />);
});

// --- management API ----------------------------------------------------------

app.get(API_ARTIFACTS, async (c) => {
  const owner = await resolveOwner(c.env, c.req.raw);
  if (!owner.ok) {
    return ownerRejection(owner);
  }

  const artifacts = await listArtifacts(c.env.DB, owner.uid);
  return c.json({
    artifacts: artifacts.map((row) => toViewItem(c.req.url, owner.uid, row)),
  });
});

app.post(API_ARTIFACTS, async (c) => {
  if (!isSameOriginRequest(c.req.raw)) {
    return crossOrigin();
  }

  const owner = await resolveOwner(c.env, c.req.raw);
  if (!owner.ok) {
    return ownerRejection(owner);
  }

  const form = await c.req.raw.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return respondUpload(c.req.raw, undefined, {
      status: 400,
      code: ErrorCodes.NOT_HTML,
      message: "HTMLファイルを選択してください。",
    });
  }

  const requestedName = readName(form) ?? file.name;
  const outcome = await storeArtifact(c.env, owner.uid, requestedName, file, new Date().toISOString());

  if (outcome.ok) {
    const url = artifactUrl(c.req.url, owner.uid, outcome.name);
    if (wantsJson(c.req.raw)) {
      return c.json(
        {
          artifact: {
            uid: owner.uid,
            name: outcome.name,
            size: outcome.size,
            visibility: outcome.visibility,
            uploadedAt: outcome.uploadedAt,
            url,
          },
        },
        201,
      );
    }
    return c.html(<UploadPage result={{ name: outcome.name, url }} />);
  }

  const failure = outcome.failure;
  switch (failure.reason) {
    case "too_large":
      return respondUpload(c.req.raw, requestedName, {
        status: 413,
        code: ErrorCodes.TOO_LARGE,
        message: `ファイルサイズが上限(${formatMegabytes(MAX_SIZE_BYTES)})を超えています。`,
        details: { limitBytes: failure.limitBytes },
      });
    case "not_html":
      return respondUpload(c.req.raw, requestedName, {
        status: 400,
        code: ErrorCodes.NOT_HTML,
        message: "HTMLファイルとして受け付けられませんでした。拡張子と内容を確認してください。",
      });
    case "invalid_name":
      return respondUpload(c.req.raw, requestedName, {
        status: 400,
        code: ErrorCodes.INVALID_NAME,
        message: failure.message,
        details: { allowed: failure.allowed },
      });
    case "name_conflict":
      return respondUpload(c.req.raw, requestedName, {
        status: 409,
        code: ErrorCodes.NAME_CONFLICT,
        message: "同じ名前のアーティファクトが既に存在します。別の名前を指定してください。",
        details: { suggestions: failure.suggestions },
        suggestions: failure.suggestions,
      });
    case "no_file":
    case "storage_failed":
      return respondUpload(c.req.raw, requestedName, {
        status: 500,
        code: ErrorCodes.STORAGE_FAILED,
        message: "保存に失敗しました。もう一度お試しください。",
      });
  }
});

app.on(["PUT", "POST"], `${API_ARTIFACTS}/:name/visibility`, async (c) => {
  if (!isSameOriginRequest(c.req.raw)) {
    return crossOrigin();
  }

  const owner = await resolveOwner(c.env, c.req.raw);
  if (!owner.ok) {
    return ownerRejection(owner);
  }

  const requested = await readVisibility(c.req.raw);
  if (requested === null) {
    return errorResponse(
      400,
      {
        code: ErrorCodes.INVALID_VISIBILITY,
        message: "visibility には public または private を指定してください。",
      },
      adminHeaderRecord(),
    );
  }

  // Scoped by the uid resolved from the identity, never by a value from the
  // request, so a caller cannot reach another namespace (FR-031, FR-038).
  const updated = await updateVisibility(
    c.env.DB,
    owner.uid,
    c.req.param("name"),
    requested,
    new Date().toISOString(),
  );

  if (!updated.ok) {
    return errorResponse(
      404,
      { code: ErrorCodes.NOT_FOUND, message: "対象のアーティファクトが見つかりません。" },
      adminHeaderRecord(),
    );
  }

  return wantsJson(c.req.raw)
    ? c.json({
        artifact: {
          name: c.req.param("name"),
          visibility: requested,
          url: artifactUrl(c.req.url, owner.uid, c.req.param("name")),
        },
      })
    : c.redirect(PATH_LIST, 303);
});

// --- artifact delivery (Access-unprotected; the Worker decides) --------------

app.get("/:uid/:name", async (c) =>
  serveArtifact(c.env, c.req.raw, c.req.param("uid"), c.req.param("name")),
);

export default app;

// --- helpers ----------------------------------------------------------------

function artifactUrl(requestUrl: string, uid: string, name: string): string {
  return new URL(`/${uid}/${encodeURIComponent(name)}`, requestUrl).toString();
}

function toViewItem(
  requestUrl: string,
  uid: string,
  row: ArtifactListItem,
): ViewArtifactListItem {
  return {
    name: row.name,
    size: row.size,
    visibility: row.visibility,
    uploadedAt: row.uploaded_at,
    visibilityChangedAt: row.visibility_changed_at,
    url: artifactUrl(requestUrl, uid, row.name),
  };
}

function readName(form: FormData): string | null {
  const value = form.get("name");
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Accepts the visibility either as JSON or as a form field, because the UI
 * posts a plain `<form>` (no client-side JavaScript) while the contract in
 * contracts/http-api.md describes a JSON body.
 */
async function readVisibility(request: Request): Promise<Visibility | null> {
  const contentType = request.headers.get("Content-Type") ?? "";
  const raw = contentType.includes("application/json")
    ? ((await request.json().catch(() => null)) as { visibility?: unknown } | null)?.visibility
    : (await request.formData().catch(() => null))?.get("visibility");

  return raw === "public" || raw === "private" ? raw : null;
}

/** Distinguishes API clients from a browser following a form submission. */
function wantsJson(request: Request): boolean {
  return (request.headers.get("Accept") ?? "").includes("application/json");
}

function respondUpload(
  request: Request,
  requestedName: string | undefined,
  error: {
    status: number;
    code: (typeof ErrorCodes)[keyof typeof ErrorCodes];
    message: string;
    details?: Record<string, unknown>;
    /** Alternative names offered on a collision, shown by the upload view. */
    suggestions?: readonly string[];
  },
): Response {
  if (wantsJson(request)) {
    return errorResponse(
      error.status,
      { code: error.code, message: error.message, details: error.details },
      adminHeaderRecord(),
    );
  }

  const viewError: UploadError = {
    message: error.message,
    ...(error.suggestions === undefined ? {} : { suggestions: [...error.suggestions] }),
  };
  return new Response(uploadPageHtml(requestedName, viewError), {
    status: error.status,
    headers: { ...adminHeaderRecord(), "Content-Type": "text/html; charset=utf-8" },
  });
}

function uploadPageHtml(defaultName: string | undefined, error: UploadError): string {
  return String(UploadPage({ defaultName, error }));
}

function crossOrigin(): Response {
  return errorResponse(
    403,
    { code: ErrorCodes.CROSS_ORIGIN, message: "クロスオリジンからの操作は許可されていません。" },
    adminHeaderRecord(),
  );
}

/**
 * Maps a failed identity resolution onto a response.
 *
 * `unauthenticated` should be unreachable in a deployed environment, because
 * Access rejects the request before it reaches the Worker. It is handled anyway
 * so the Worker fails closed if the Access application is ever misconfigured.
 */
function ownerRejection(owner: Extract<OwnerResolution, { ok: false }>): Response {
  switch (owner.reason) {
    case "not_registered":
      return errorResponse(
        403,
        {
          code: ErrorCodes.NOT_FOUND,
          message: `${owner.email} には uid が発行されていません。運用者による発行が必要です。`,
        },
        adminHeaderRecord(),
      );
    case "misconfigured":
      return errorResponse(
        500,
        {
          code: ErrorCodes.STORAGE_FAILED,
          message: "認証設定が未完了です。ACCESS_TEAM_DOMAIN と ACCESS_AUD を設定してください。",
        },
        adminHeaderRecord(),
      );
    case "unauthenticated":
      return errorResponse(
        401,
        { code: ErrorCodes.NOT_FOUND, message: "認証が必要です。" },
        adminHeaderRecord(),
      );
  }
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export { PATH_UPLOAD };
