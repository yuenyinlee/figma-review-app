import { google } from "googleapis";

/**
 * Reuses the same service account already configured for the guidelines
 * doc (GOOGLE_SERVICE_ACCOUNT_KEY) -- a static credential (share the sheet
 * with its email as an Editor, done once), not an interactive per-user
 * OAuth flow, since this only ever runs server-side.
 */
function getServiceAccountCredentials(): Record<string, unknown> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not set -- create a Google service account, share the " +
        "feedback sheet with its email as an Editor, and set its JSON key (base64-encoded) " +
        "as this environment variable."
    );
  }
  return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
}

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function getFeedbackSheetId(): string {
  const id = process.env.FEEDBACK_SHEET_ID;
  if (!id) {
    throw new Error("FEEDBACK_SHEET_ID is not set in the environment (.env file)");
  }
  return id;
}

export interface AppFeedbackInput {
  comment: string;
  categories: string[];
  commenterName: string;
  projectName?: string;
}

/**
 * Appends a new row to the team's feedback Google Sheet -- one row per
 * submission from the plugin's "Leave Feedback" form. Columns: timestamp
 * (written explicitly here, since unlike Notion, Sheets has no built-in
 * auto-populated creation time), commenter, categories (joined with ", "),
 * comment, project name.
 */
export async function appendFeedbackRow(input: AppFeedbackInput): Promise<void> {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: getFeedbackSheetId(),
    range: "A:E",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          new Date().toLocaleString(),
          input.commenterName,
          input.categories.join(", "),
          input.comment,
          input.projectName ?? "",
        ],
      ],
    },
  });
}
