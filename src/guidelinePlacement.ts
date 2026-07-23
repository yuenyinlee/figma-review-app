import { getClient, MODEL, ReviewLanguage, LANGUAGE_NAMES } from "./claude";

export interface GuidelinePlacement {
  guideline: string;
  /** Exact target section heading text (without the ## marker). */
  section: string;
  /** True if `section` isn't among the doc's existing headings. */
  isNewSection: boolean;
  /**
   * If this guideline directly contradicts an existing bullet elsewhere in
   * the doc, that bullet's exact text (verbatim, without its leading "- ").
   * Absent when there's no conflict.
   */
  conflictsWithText?: string;
  conflictExplanation?: string;
}

const PLACEMENT_SCHEMA = {
  type: "object",
  properties: {
    placements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          guideline: {
            type: "string",
            description: "Echo back this guideline's text exactly as given, unchanged.",
          },
          section: {
            type: "string",
            description:
              "The existing section heading (exact text, without the ## marker) this guideline " +
              "best belongs under. Only propose a new section name if none of the existing " +
              "sections genuinely fit.",
          },
          isNewSection: {
            type: "boolean",
            description: "True if `section` is a new name, not one of the document's existing headings.",
          },
          conflictsWithText: {
            type: "string",
            description:
              "If this guideline directly contradicts an existing bullet point anywhere in the " +
              "document (requires the opposite of what that bullet already states), the exact " +
              "text of that existing bullet, verbatim, without its leading '- '. Omit entirely " +
              "if there's no genuine contradiction -- being merely related, more specific, or " +
              "additive doesn't count as a conflict.",
          },
          conflictExplanation: {
            type: "string",
            description: "If conflictsWithText is set, one brief sentence explaining the contradiction.",
          },
        },
        required: ["guideline", "section", "isNewSection"],
        additionalProperties: false,
      },
    },
  },
  required: ["placements"],
  additionalProperties: false,
} as const;

/**
 * Decides, for each newly-confirmed guideline, which existing section of
 * the guidelines doc it belongs under (or whether it needs a new section),
 * and whether it directly contradicts an existing bullet elsewhere in the
 * doc -- surfaced so a human can decide whether to replace the old rule
 * before anything gets written.
 */
export async function planGuidelinePlacements(
  guidelines: string[],
  existingContent: string,
  language?: ReviewLanguage
): Promise<GuidelinePlacement[]> {
  const anthropic = getClient();
  const languageName = LANGUAGE_NAMES[language ?? "en"];

  const prompt =
    "You are helping organize new design guidelines into an existing team guidelines document.\n\n" +
    `Here is the current guidelines document:\n"""\n${existingContent}\n"""\n\n` +
    "Here are new guidelines to add:\n" +
    guidelines.map((g, i) => `${i + 1}. ${g}`).join("\n") +
    "\n\n" +
    "For each new guideline:\n" +
    "1. Decide which EXISTING section heading (exact text) it best belongs under -- reuse an " +
    "existing section whenever it reasonably fits, and only propose a new section name when " +
    "none of the existing ones do.\n" +
    "2. Check whether it directly contradicts any existing bullet point ANYWHERE in the " +
    "document (not just within the same section) -- i.e. it requires the opposite of what an " +
    "existing bullet already states. If so, quote that bullet's exact text and briefly explain " +
    "the contradiction. Only flag genuine contradictions; a guideline that's merely related, " +
    "more specific, or additive is not a conflict.\n\n" +
    `Write the section and conflictExplanation fields entirely in ${languageName}. Echo the ` +
    "guideline field back exactly as given, and conflictsWithText exactly as it appears in the " +
    "document (character for character, so it can be located and replaced).";

  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: { type: "json_schema", schema: PLACEMENT_SCHEMA },
      },
    },
    { timeout: 60_000 }
  );

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response while planning guideline placement");
  }

  const parsed = JSON.parse(textBlock.text) as { placements: GuidelinePlacement[] };
  return parsed.placements;
}
