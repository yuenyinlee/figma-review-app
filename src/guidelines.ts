import fetch from "node-fetch";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * GUIDELINES_DOC_ID can be just the doc's id, or the whole share URL --
 * either way we just need the id out of it to build the export link.
 */
function getDocId(): string | undefined {
  const raw = process.env.GUIDELINES_DOC_ID;
  if (!raw) return undefined;

  const match = raw.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : raw.trim();
}

/**
 * Reads the team's current design guidelines from a link-shared Google Doc
 * -- the single source of truth every review (and guideline-verification
 * run) checks a frame against. Editing happens directly in Google Docs'
 * own interface, not through this app; we just fetch the latest content on
 * every call, so an edit takes effect on the very next review with no
 * redeploy needed. Returns undefined if no doc is configured, or it's
 * empty -- this feature is optional.
 */
export async function getGuidelines(): Promise<string | undefined> {
  const docId = getDocId();
  if (!docId) return undefined;

  const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const res = await fetch(url, { timeout: REQUEST_TIMEOUT_MS });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch guidelines doc (${res.status}). Make sure it's shared as ` +
        `"Anyone with the link can view".`
    );
  }

  const content = (await res.text()).trim();
  return content.length > 0 ? content : undefined;
}
