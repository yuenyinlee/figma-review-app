import { Pool } from "pg";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set in the environment (.env file)");
    }
    // Managed Postgres providers (Supabase included) sit behind a
    // certificate Node's default CA store doesn't trust out of the box.
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

let tableReady: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = getPool()
      .query(
        `
        CREATE TABLE IF NOT EXISTS guidelines (
          id INTEGER PRIMARY KEY,
          content TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `
      )
      .then(() => undefined);
  }
  return tableReady;
}

/**
 * Reads the team's current design guidelines -- the single source of truth
 * every review (and guideline-verification run) checks a frame against.
 * Stored in the database (not a local file) so it survives redeploys and
 * can be updated by anyone through the app, not just whoever can edit a
 * file on the machine running the backend. Returns undefined if none have
 * been set yet -- this feature is optional, like the old file-based version.
 */
export async function getGuidelines(): Promise<string | undefined> {
  await ensureTable();
  const result = await getPool().query<{ content: string }>("SELECT content FROM guidelines WHERE id = 1");
  const content = result.rows[0]?.content?.trim();
  return content && content.length > 0 ? content : undefined;
}

/**
 * Replaces the team's guidelines. This is the "write and update rules
 * through the app" path -- no file access or redeploy required.
 */
export async function updateGuidelines(content: string): Promise<void> {
  await ensureTable();
  await getPool().query(
    `INSERT INTO guidelines (id, content, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at`,
    [content]
  );
}
