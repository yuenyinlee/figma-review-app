import { google } from "googleapis";
import { getGuidelines, getGuidelinesDocId } from "./guidelines";

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
        "guidelines file with its email as an Editor, and set its JSON key (base64-encoded) " +
        "as this environment variable."
    );
  }
  return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
}

function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

function formatAppendedSection(guidelines: string[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const bullets = guidelines.map((g) => `- ${g}`).join("\n");
  return `\n\n## Added ${date}\n\n${bullets}\n`;
}

/**
 * Appends newly-confirmed guidelines to the end of the guidelines .md file,
 * under a dated heading, so the trail of what was added and when stays
 * visible. Re-fetches the current content first so this always builds on
 * the latest version rather than a stale copy.
 */
export async function appendGuidelinesToDoc(guidelines: string[]): Promise<void> {
  if (guidelines.length === 0) return;

  const docId = getGuidelinesDocId();
  if (!docId) {
    throw new Error("GUIDELINES_DOC_ID is not set -- can't determine which file to update.");
  }

  const currentContent = (await getGuidelines()) ?? "";
  const newContent = currentContent + formatAppendedSection(guidelines);

  const drive = getDriveClient();
  await drive.files.update({
    fileId: docId,
    media: { mimeType: "text/plain", body: newContent },
  });
}
