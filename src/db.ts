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
