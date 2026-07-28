import { getClient, MODEL, ReviewLanguage, LANGUAGE_NAMES } from "./claude";

export interface CandidateForPlacement {
  guideline: string;
  platform: "web" | "mobile" | "both";
}

export interface RelatedRule {
  /** Exact existing bullet text, verbatim (without its leading "- "), so it can be located. */
  text: string;
  relationship: "similar" | "contradictory";
  /** Brief note on how it relates -- shown to the human deciding whether to replace it. */
  explanation: string;
}

export interface GuidelinePlacement {
  guideline: string;
  /** Echoed back from the input, unchanged. */
  platform: "web" | "mobile" | "both";
  /** Exact target section heading text (without the ## marker). */
  section: string;
  /** True if `section` isn't among the doc's existing headings. */
  isNewSection: boolean;
  /** Existing bullets that overlap with or contradict this guideline, scoped to what it could actually apply alongside (see platform). */
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
          platform: {
            type: "string",
            enum: ["web", "mobile", "both"],
            description: "Echo back the given platform scope for this guideline exactly, unchanged.",
          },
          section: {
            type: "string",
            description:
              "The existing TOP-LEVEL category heading (a '##' heading, e.g. 'Components', " +
              "'Color', 'Spacing') this guideline best belongs under -- copy its exact text " +
              "verbatim (without the ## marker), UNTRANSLATED. NEVER return a nested '###' " +
              "platform sub-heading here (e.g. 'Web' or 'Mobile') -- even for a platform-" +
              "specific guideline, this must be the enclosing '##' category, since the " +
              "sub-heading is placed automatically afterward from the platform field, not " +
              "from this one. Only propose a new '##' category name (in English) if none of " +
              "the existing ones genuinely fit.",
          },
          isNewSection: {
            type: "boolean",
            description: "True if `section` is a new name, not one of the document's existing headings.",
          },
          relatedRules: {
            type: "array",
            description:
              "Existing bullets that meaningfully overlap with or contradict this guideline, " +
              "scoped to what it could actually apply alongside (see the platform-scoping " +
              "instructions). Empty if there's nothing related.",
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
        required: ["guideline", "platform", "section", "isNewSection", "relatedRules"],
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
 * and lists every existing bullet it could actually apply alongside (see
 * platform scoping below) that's similar to or contradicts it -- surfaced
 * so a human can decide whether to add the guideline alongside those, or
 * replace one of them, before anything gets written. Purely a text
 * comparison against the current doc -- no synthetic mockup or image
 * involved.
 *
 * Some existing categories nest a "### Web" or "### Mobile" sub-heading
 * for platform-specific rules; a bullet directly under a category's main
 * heading (no sub-heading) is shared and applies to both platforms. A
 * candidate scoped to one platform should only be checked against shared
 * bullets and bullets already under that SAME platform's sub-heading --
 * never the other platform's, since those don't apply in the same
 * context. Where each candidate actually lands within its section
 * (directly under the heading vs. under a platform sub-heading) is handled
 * mechanically afterward from its `platform` field, not decided here.
 */
export async function planGuidelinePlacements(
  candidates: CandidateForPlacement[],
  existingContent: string,
  language?: ReviewLanguage
): Promise<GuidelinePlacement[]> {
  const anthropic = getClient();
  const languageName = LANGUAGE_NAMES[language ?? "en"];

  const prompt =
    "You are helping organize new design guidelines into an existing team guidelines document.\n\n" +
    `Here is the current guidelines document:\n"""\n${existingContent}\n"""\n\n` +
    "Some categories above may nest a \"### Web\" or \"### Mobile\" sub-heading -- a bullet " +
    "directly under a category's main heading (no platform sub-heading) is shared and applies " +
    "to both platforms; a bullet under a platform sub-heading applies only to that platform.\n\n" +
    "Here are new guidelines to add, each tagged with which platform it applies to:\n" +
    candidates.map((c, i) => `${i + 1}. [${c.platform}] ${c.guideline}`).join("\n") +
    "\n\n" +
    "For each new guideline:\n" +
    "1. Decide which EXISTING top-level '##' category heading (exact text) it best belongs " +
    "under -- reuse an existing category whenever it reasonably fits, and only propose a new " +
    "one when none of the existing ones do. This must always be a '##' category, NEVER a " +
    "nested '###' platform sub-heading -- e.g. if 'Components' contains a '### Mobile' sub-" +
    "section and you're placing another mobile-only guideline about components, the correct " +
    "section is 'Components', not 'Mobile'.\n" +
    "2. List existing bullets that meaningfully relate to it -- a direct contradiction " +
    "(requires the opposite of what the new guideline says) or significant overlap/" +
    "duplication -- but ONLY bullets this guideline could actually apply alongside: for a " +
    "'both' guideline, consider ALL existing bullets anywhere in the document; for a 'web' " +
    "or 'mobile' guideline, consider ONLY shared bullets (not under any platform sub-heading) " +
    "and bullets already under that SAME platform's sub-heading -- never the other " +
    "platform's sub-heading. Don't silently decide for the user which one should win -- " +
    "surface all of them so a human can choose. Only include genuinely relevant bullets, not " +
    "anything vaguely in the same topic area.\n\n" +
    `Write only the explanation field in ${languageName} -- that's just commentary for the ` +
    "human reviewing this. Everything else must stay exactly as it appears in the source " +
    "material, untranslated: echo the guideline and platform fields back exactly as given, " +
    "copy the section field verbatim if reusing an existing heading, and copy each " +
    "relatedRules text exactly as it appears in the document (character for character, so it " +
    "can be located and replaced).";

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
