import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(__dirname, "..", "reviews.db");
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    file_key TEXT NOT NULL,
    node_id TEXT NOT NULL,
    status TEXT NOT NULL,
    critique TEXT,
    figma_comment_id TEXT,
    error TEXT
  )
`);

// Additive migration for the Figma plugin's review-and-annotate path, which
// has no comment id to log (it writes real Dev Mode annotations instead of
// posting a comment). Guarded because SQLite has no "ADD COLUMN IF NOT EXISTS".
try {
  db.exec(`ALTER TABLE reviews ADD COLUMN annotated_node_ids TEXT`);
} catch {
  // column already exists
}

export interface ReviewLogInput {
  fileKey: string;
  nodeId: string;
  status: "success" | "error";
  critique?: string;
  figmaCommentId?: string;
  annotatedNodeIds?: string;
  error?: string;
}

const insertStmt = db.prepare(`
  INSERT INTO reviews (file_key, node_id, status, critique, figma_comment_id, annotated_node_ids, error)
  VALUES (@fileKey, @nodeId, @status, @critique, @figmaCommentId, @annotatedNodeIds, @error)
`);

export function logReview(input: ReviewLogInput): void {
  insertStmt.run({
    fileKey: input.fileKey,
    nodeId: input.nodeId,
    status: input.status,
    critique: input.critique ?? null,
    figmaCommentId: input.figmaCommentId ?? null,
    annotatedNodeIds: input.annotatedNodeIds ?? null,
    error: input.error ?? null,
  });
}

export function listReviews(limit = 20) {
  return db
    .prepare(`SELECT * FROM reviews ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS comment_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    file_key TEXT NOT NULL,
    node_id TEXT NOT NULL,
    figma_comment_id TEXT,
    category TEXT,
    element_description TEXT,
    comment TEXT NOT NULL,
    verdict TEXT NOT NULL,
    commenter_name TEXT
  )
`);

export interface CommentFeedbackInput {
  fileKey: string;
  nodeId: string;
  figmaCommentId?: string;
  category?: string;
  elementDescription?: string;
  comment: string;
  verdict: "up" | "down";
  commenterName?: string;
}

const insertFeedbackStmt = db.prepare(`
  INSERT INTO comment_feedback
    (file_key, node_id, figma_comment_id, category, element_description, comment, verdict, commenter_name)
  VALUES
    (@fileKey, @nodeId, @figmaCommentId, @category, @elementDescription, @comment, @verdict, @commenterName)
`);

export function logCommentFeedback(input: CommentFeedbackInput): void {
  insertFeedbackStmt.run({
    fileKey: input.fileKey,
    nodeId: input.nodeId,
    figmaCommentId: input.figmaCommentId ?? null,
    category: input.category ?? null,
    elementDescription: input.elementDescription ?? null,
    comment: input.comment,
    verdict: input.verdict,
    commenterName: input.commenterName ?? null,
  });
}

/**
 * Recent thumbs-down comments, used as "avoid comments like these" examples
 * in future review prompts (see src/claude.ts). Most-recent-first, capped so
 * a long history doesn't bloat the prompt -- recent feedback is also more
 * likely to reflect the team's current judgment than very old reactions.
 */
export function getRecentDownvotedComments(limit = 15): string[] {
  const rows = db
    .prepare(`SELECT comment FROM comment_feedback WHERE verdict = 'down' ORDER BY id DESC LIMIT ?`)
    .all(limit) as { comment: string }[];
  return rows.map((r) => r.comment);
}
