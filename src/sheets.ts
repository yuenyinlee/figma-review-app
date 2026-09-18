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

// Reactions live in their own tab of the same spreadsheet -- reusing the
// feedback form's sheet/credentials rather than asking the user to share
// (and pay for) a whole separate persistent store. Column order: Timestamp,
// Verdict, ReasonTags, Category, ElementDescription, Comment, Commenter,
// FileKey, NodeId, FigmaCommentId.
const REACTIONS_RANGE = "Reactions!A:J";

export interface CommentReactionInput {
  fileKey: string;
  nodeId: string;
  figmaCommentId?: string;
  category?: string;
  elementDescription?: string;
  comment: string;
  verdict: "up" | "down";
  commenterName?: string;
  reasonTags?: string[];
}

/**
 * Appends one thumbs up/down reaction as a new row. This -- not SQLite --
 * is the durable store for comment_feedback: Render's free tier has no
 * persistent disk, so anything written to the local reviews.db is lost on
 * every redeploy or idle restart, which defeats the point of building up
 * feedback history to improve comment quality over time.
 */
export async function appendCommentReactionRow(input: CommentReactionInput): Promise<void> {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: getFeedbackSheetId(),
    range: REACTIONS_RANGE,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          new Date().toLocaleString(),
          input.verdict,
          input.reasonTags && input.reasonTags.length > 0 ? input.reasonTags.join(", ") : "",
          input.category ?? "",
          input.elementDescription ?? "",
          input.comment,
          input.commenterName ?? "",
          input.fileKey,
          input.nodeId,
          input.figmaCommentId ?? "",
        ],
      ],
    },
  });
}

interface ReactionRow {
  timestamp: string;
  verdict: string;
  reasonTags: string;
  category: string;
  elementDescription: string;
  comment: string;
  commenterName: string;
  fileKey: string;
  nodeId: string;
  figmaCommentId: string;
}

async function fetchReactionRows(): Promise<ReactionRow[]> {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getFeedbackSheetId(),
    range: REACTIONS_RANGE,
  });
  const rows = res.data.values ?? [];
  return rows.map((row) => ({
    timestamp: row[0] ?? "",
    verdict: row[1] ?? "",
    reasonTags: row[2] ?? "",
    category: row[3] ?? "",
    elementDescription: row[4] ?? "",
    comment: row[5] ?? "",
    commenterName: row[6] ?? "",
    fileKey: row[7] ?? "",
    nodeId: row[8] ?? "",
    figmaCommentId: row[9] ?? "",
  }));
}

export interface DownvotedComment {
  comment: string;
  reasonTags: string | null;
}

/**
 * Recent thumbs-down comments, used as "avoid comments like these" examples
 * in future review prompts (see src/claude.ts). Most-recent-first, capped so
 * a long history doesn't bloat the prompt.
 */
export async function getRecentDownvotedComments(limit = 15): Promise<DownvotedComment[]> {
  const rows = await fetchReactionRows();
  return rows
    .filter((r) => r.verdict === "down")
    .slice(-limit)
    .reverse()
    .map((r) => ({ comment: r.comment, reasonTags: r.reasonTags || null }));
}

/** Most recent reactions of either verdict, for the /comment-feedback inspection endpoint. */
export async function listCommentFeedback(limit = 20): Promise<ReactionRow[]> {
  const rows = await fetchReactionRows();
  return rows.slice(-limit).reverse();
}
