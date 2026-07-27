import fetch from "node-fetch";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A raw value can be just a doc/file id, or the whole share URL -- either a
 * Google Docs link (/document/d/ID) or a Drive file link (/file/d/ID) --
 * either way we just need the id out of it.
 */
export function parseDriveDocId(raw: string): string {
  const match = raw.match(/\/(?:document|file)\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : raw.trim();
}

/**
 * Native Google Docs (created in Docs, not uploaded) aren't downloadable
 * raw bytes -- Drive's file-download endpoint 500s on them. They need
 * Docs' own export endpoint instead. A bare id or a /file/d/ link (an
 * uploaded file, e.g. the guidelines .md) uses the Drive endpoint as before.
 */
function isNativeDocsLink(raw: string): boolean {
  return /\/document\/d\//.test(raw);
}

/**
 * Fetches the plain-text content of a link-shared Google Doc or Drive file
 * -- accepts either the full share URL or a bare id. Shared by the
 * guidelines file fetch below and the meeting-minutes extraction feature,
 * which points this at whatever doc link the user submits.
 */
export async function fetchDriveFileText(link: string): Promise<string> {
  const id = parseDriveDocId(link);
  const url = isNativeDocsLink(link)
    ? `https://docs.google.com/document/d/${id}/export?format=txt`
    : `https://drive.google.com/uc?export=download&id=${id}`;

  const res = await fetch(url, { timeout: REQUEST_TIMEOUT_MS });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch the doc (${res.status}). Make sure it's shared as ` +
        `"Anyone with the link can view".`
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  // Google Docs' plain-text export uses CRLF line endings -- normalize to
  // plain \n so line-based parsing (and anything written back later) stays
  // consistent regardless of source.
  const content = (await res.text()).replace(/\r\n/g, "\n").trim();

  // A small text file/export should come back directly. If we instead get
  // an HTML page, it's either a sharing-permission issue (redirected to a
  // sign-in page) or a download confirmation interstitial -- either way,
  // that HTML isn't the doc's content, so surface a clear error instead of
  // silently using it as one.
  if (contentType.includes("text/html")) {
    throw new Error(
      "Got an HTML page instead of the doc's content -- check that it's shared as " +
        '"Anyone with the link can view", and that the link points at the doc itself, ' +
        "not a folder."
    );
  }

  return content;
}

/**
 * The guidelines file's id, parsed from GUIDELINES_DOC_ID -- needed by
 * src/driveWrite.ts to know which file to update when appending newly
 * confirmed guidelines.
 */
export function getGuidelinesDocId(): string | undefined {
  const raw = process.env.GUIDELINES_DOC_ID;
  return raw ? parseDriveDocId(raw) : undefined;
}

/**
 * Reads the team's current design guidelines from a link-shared native
 * Google Doc -- the single source of truth every review (and the
 * meeting-minutes placement check) compares a frame or candidate against.
 * Most edits happen directly in the doc, but confirmed guidelines from the
 * meeting-minutes review page are written here too (see src/driveWrite.ts).
 * We fetch the latest content on every call, so any edit takes effect on
 * the very next review with no redeploy needed. Returns undefined if no
 * doc is configured, or it's empty -- this feature is optional.
 */
export async function getGuidelines(): Promise<string | undefined> {
  const raw = process.env.GUIDELINES_DOC_ID;
  if (!raw) return undefined;

  const content = await fetchDriveFileText(raw);
  return content.length > 0 ? content : undefined;
}
