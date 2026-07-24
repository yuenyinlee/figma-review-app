import { getClient, MODEL, ReviewLanguage, LANGUAGE_NAMES } from "./claude";

export interface RelatedRule {
  /** Exact existing bullet text, verbatim (without its leading "- "), so it can be located. */
  text: string;
  relationship: "similar" | "contradictory";
  /** Brief note on how it relates -- shown to the human deciding whether to replace it. */
  explanation: string;
}

export interface GuidelinePlacement {
  guideline: string;
  /** Exact target section heading text (without the ## marker). */
  section: string;
  /** True if `section` isn't among the doc's existing headings. */
  isNewSection: boolean;
  /** Existing bullets anywhere in the doc that overlap with or contradict this guideline. */
  relatedRules: RelatedRule[];
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
              "The existing section heading this guideline best belongs under -- copy its exact " +
              "text verbatim (without the ## marker), UNTRANSLATED, since it must match the " +
              "document's actual heading to be found. Only propose a new section name (in " +
              "English) if none of the existing sections genuinely fit.",
          },
          isNewSection: {
            type: "boolean",
            description: "True if `section` is a new name, not one of the document's existing headings.",
          },
          relatedRules: {
            type: "array",
            description:
              "Every existing bullet point anywhere in the document that meaningfully overlaps " +
              "with or contradicts this guideline. Empty if there's nothing related.",
            items: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                  description:
                    "The exact text of the existing bullet, verbatim, without its leading '- ' " +
                    "(character for character, so it can be located in the document).",
                },
                relationship: {
                  type: "string",
                  enum: ["similar", "contradictory"],
                  description:
                    "'contradictory' if this existing rule requires the opposite of the new " +
                    "guideline; 'similar' if it overlaps, duplicates, or is otherwise closely " +
                    "related without directly conflicting.",
                },
                explanation: {
                  type: "string",
                  description: "One brief sentence on how the two relate.",
                },
              },
              required: ["text", "relationship", "explanation"],
              additionalProperties: false,
            },
          },
        },
        required: ["guideline", "section", "isNewSection", "relatedRules"],
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
 * and lists every existing bullet anywhere in the doc that's similar to or
 * contradicts it -- surfaced so a human can decide whether to add the
 * guideline alongside those, or replace one of them, before anything gets
 * written. Purely a text comparison against the current doc -- no
 * synthetic mockup or image involved.
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
    "2. List EVERY existing bullet point anywhere in the document (not just within the same " +
    "section) that meaningfully relates to it -- whether that's a direct contradiction " +
    "(requires the opposite of what the new guideline says) or just significant overlap/" +
    "duplication. Don't silently decide for the user which one should win -- surface all of " +
    "them so a human can choose. Only include genuinely relevant bullets, not anything vaguely " +
    "in the same topic area.\n\n" +
    `Write only the explanation field in ${languageName} -- that's just commentary for the ` +
    "human reviewing this. Everything else must stay exactly as it appears in the source " +
    "material, untranslated: echo the guideline field back exactly as given (English), copy " +
    "the section field verbatim if reusing an existing heading, and copy each relatedRules " +
    "text exactly as it appears in the document (character for character, so it can be " +
    "located and replaced).";

  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 2500,
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
