import { Client } from "@notionhq/client";

function getNotionClient(): Client {
  const token = process.env.NOTION_API_KEY;
  if (!token) {
    throw new Error("NOTION_API_KEY is not set in the environment (.env file)");
  }
  return new Client({ auth: token });
}

function getFeedbackDatabaseId(): string {
  const id = process.env.NOTION_FEEDBACK_DATABASE_ID;
  if (!id) {
    throw new Error("NOTION_FEEDBACK_DATABASE_ID is not set in the environment (.env file)");
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
 * Adds a new entry to the team's Notion feedback database -- one row per
 * submission from the plugin's "Leave Feedback" form. The database's
 * built-in "Created time" property supplies the timestamp automatically
 * (never set by us), matching the form's "date and time, uneditable"
 * requirement without duplicating that data ourselves.
 *
 * Expects the database to have these exact properties: a title property
 * (holds the comment text -- whatever it's named, Notion requires exactly
 * one per database), "Category" (multi-select, with these option names
 * already created: Unnecessary, Repeated, Bug, Missing Detection),
 * "Commenter" (rich text), and "Project" (rich text).
 */
export async function createFeedbackEntry(input: AppFeedbackInput): Promise<void> {
  const notion = getNotionClient();

  const database = await notion.databases.retrieve({ database_id: getFeedbackDatabaseId() });
  const properties = (database as { properties?: Record<string, { type: string }> }).properties;
  if (!properties) {
    throw new Error("Couldn't read the configured Notion database's properties (check the integration has access)");
  }
  const titlePropertyName = Object.entries(properties).find(([, prop]) => prop.type === "title")?.[0];
  if (!titlePropertyName) {
    throw new Error("The configured Notion database has no title property -- every Notion database needs one");
  }

  await notion.pages.create({
    parent: { database_id: getFeedbackDatabaseId() },
    properties: {
      [titlePropertyName]: {
        title: [{ text: { content: input.comment } }],
      },
      Category: {
        multi_select: input.categories.map((name) => ({ name })),
      },
      Commenter: {
        rich_text: [{ text: { content: input.commenterName } }],
      },
      Project: {
        rich_text: input.projectName ? [{ text: { content: input.projectName } }] : [],
      },
    },
  });
}
