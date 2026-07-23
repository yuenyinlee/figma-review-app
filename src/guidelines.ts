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
 * Fetches the plain-text content of a link-shared Drive file by id. Shared
 * by the guidelines file fetch below and the meeting-minutes extraction
 * feature, which points this at whatever doc link the user submits.
 */
export async function fetchDriveFileText(docId: string): Promise<string> {
  const url = `https://drive.google.com/uc?export=download&id=${docId}`;
  const res = await fetch(url, { timeout: REQUEST_TIMEOUT_MS });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch Drive file (${res.status}). Make sure it's shared as ` +
        `"Anyone with the link can view".`
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  const content = (await res.text()).trim();

  // A small text file should come back directly. If Drive instead serves an
  // HTML page, it's either a sharing-permission issue or a download
  // confirmation interstitial -- either way, that HTML isn't the file's
  // content, so surface a clear error instead of silently using it as one.
  if (contentType.includes("text/html")) {
    throw new Error(
      "Got an HTML page instead of the file's content -- check that it's shared as " +
        '"Anyone with the link can view", and that the link points at the file itself, ' +
        "not a folder."
    );
  }

  return content;
}

/**
 * GUIDELINES_DOC_ID can be just the doc's id, or the whole share URL.
 */
function getConfiguredDocId(): string | undefined {
  const raw = process.env.GUIDELINES_DOC_ID;
  return raw ? parseDriveDocId(raw) : undefined;
}

/**
 * Reads the team's current design guidelines from a link-shared Drive file
 * (the guidelines .md, uploaded directly rather than a native Google Doc)
 * -- the single source of truth every review (and guideline-verification
 * run) checks a frame against. Editing happens by re-uploading/editing that
 * file in Drive, not through this app; we just fetch the latest content on
 * every call, so an edit takes effect on the very next review with no
 * redeploy needed. Returns undefined if no file is configured, or it's
 * empty -- this feature is optional.
 */
export async function getGuidelines(): Promise<string | undefined> {
  const docId = getConfiguredDocId();
  if (!docId) return undefined;

  const content = await fetchDriveFileText(docId);
  return content.length > 0 ? content : undefined;
}
