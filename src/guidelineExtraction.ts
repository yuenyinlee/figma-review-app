import { getClient, MODEL, ReviewLanguage, LANGUAGE_NAMES } from "./claude";

export interface CandidateGuideline {
  /** A clear, actionable guideline sentence, matching the existing doc's style. */
  guideline: string;
  /** Brief note on which part of the discussion this came from, for the human reviewing it. */
  rationale: string;
}

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          guideline: {
            type: "string",
            description:
              "A single, clear, actionable design-guideline sentence -- phrased as a rule " +
              "a reviewer could check a frame against, matching the tone of the existing " +
              "guidelines doc (e.g. 'Destructive actions must use the danger button variant, " +
              "never the primary variant.').",
          },
          rationale: {
            type: "string",
            description:
              "One brief sentence on which part of the meeting this came from, so a human " +
              "reviewing the candidate can quickly check it against the source discussion " +
              "(e.g. 'Discussed while reviewing the checkout flow -- team agreed error states " +
              "must persist until the user acts.').",
          },
        },
        required: ["guideline", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

interface ExtractionResponse {
  candidates: CandidateGuideline[];
}

/**
 * Reads a meeting's minutes text and pulls out concrete, actionable design
 * decisions worth adding to the team's guidelines doc -- filtered against
 * what's already documented so it doesn't propose duplicates. Returns an
 * empty list if the notes don't contain any genuinely new, testable
 * decision (no minimum, never pad).
 */
export async function extractCandidateGuidelines(
  minutesText: string,
  existingGuidelines?: string,
  language?: ReviewLanguage
): Promise<CandidateGuideline[]> {
  const anthropic = getClient();

  const existingSection = existingGuidelines
    ? `Here are the guidelines already documented -- do not propose anything already adequately ` +
      `covered by these, only genuinely new additions:\n"""\n${existingGuidelines}\n"""\n\n`
    : "";

  const languageName = LANGUAGE_NAMES[language ?? "en"];

  const prompt =
    "You are helping a design team turn meeting notes into additions to their design " +
    "guidelines doc, which an automated review tool later checks Figma frames against.\n\n" +
    existingSection +
    `Here are the meeting minutes to review:\n"""\n${minutesText}\n"""\n\n` +
    "Go through the notes and identify any concrete, actionable design decisions the team " +
    "actually agreed on -- rules about component usage, layout, color, spacing, accessibility, " +
    "copy, or interaction patterns that a reviewer (human or automated) could check a design " +
    "against. Phrase each as a single clear guideline sentence, not a summary of the discussion. " +
    "Skip vague chatter, undecided debates, action items unrelated to design rules, and anything " +
    "already covered by the existing guidelines above. If the notes don't contain any genuinely " +
    "new, concrete decision, return an empty list -- do not invent or pad with restatements of " +
    "existing guidelines or generic best practices that weren't actually discussed.\n\n" +
    `Write the guideline and rationale fields entirely in ${languageName}.`;

  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
      },
    },
    { timeout: 60_000 }
  );

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response while extracting candidate guidelines");
  }

  const parsed = JSON.parse(textBlock.text) as ExtractionResponse;
  return parsed.candidates;
}
