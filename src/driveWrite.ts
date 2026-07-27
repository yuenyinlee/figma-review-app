import { google, docs_v1 } from "googleapis";
import { getGuidelines, getGuidelinesDocId } from "./guidelines";
import { applyUpdatesToDoc, GuidelineApplyItem } from "./guidelinesDocEditor";

/**
 * GOOGLE_SERVICE_ACCOUNT_KEY holds the service account's JSON key,
 * base64-encoded so its newlines/quotes survive Render's env var UI intact.
 * A service account is a static credential (share the file with its email
 * as an Editor, done once) -- not an interactive per-user OAuth flow, since
 * this only ever runs server-side.
 */
function getServiceAccountCredentials(): Record<string, unknown> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not set -- create a Google service account, share the " +
        "guidelines doc with its email as an Editor, and set its JSON key (base64-encoded) " +
        "as this environment variable."
    );
  }
  return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
}

function getDocsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/documents"],
  });
  return google.docs({ version: "v1", auth });
}

/**
 * Applies human-confirmed guideline placements/replacements to the
 * guidelines doc: each item lands as a new bullet under its target section
 * (creating the section if needed), or -- if the human chose to replace
 * one of the related existing rules -- overwrites that rule's exact text
 * in place. Re-fetches the current content first so this always builds on
 * the latest version rather than a stale copy.
 *
 * The guidelines doc is a native Google Doc, so unlike an uploaded file
 * its content can't be overwritten with a single media upload -- this
 * clears the doc's body and re-inserts the updated text via the Docs API.
 * Headings still need to be literal "## Heading" text lines (not Google
 * Docs' own Heading paragraph style), since that's what the parser in
 * src/guidelinesDocEditor.ts looks for.
 */
export async function applyGuidelineUpdates(items: GuidelineApplyItem[]): Promise<void> {
  if (items.length === 0) return;

  const docId = getGuidelinesDocId();
  if (!docId) {
    throw new Error("GUIDELINES_DOC_ID is not set -- can't determine which file to update.");
  }

  const currentContent = (await getGuidelines()) ?? "";
  const newContent = applyUpdatesToDoc(currentContent, items);

  const docs = getDocsClient();
  const doc = await docs.documents.get({ documentId: docId });
  const content = doc.data.body?.content ?? [];
  const endIndex = content.length > 0 ? content[content.length - 1].endIndex ?? 1 : 1;

  const requests: docs_v1.Schema$Request[] = [];
  // The doc's final newline can't be deleted -- only clear existing content
  // if there's actually something there to clear.
  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }
  requests.push({ insertText: { location: { index: 1 }, text: newContent } });

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  });
}
