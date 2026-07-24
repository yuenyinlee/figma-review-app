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
              "A single, clear, actionable design-guideline sentence, ALWAYS in English " +
              "regardless of what language the meeting notes are in -- this gets written " +
              "directly into the team's guidelines file, which is English-only. Phrase it as " +
              "a rule a reviewer could check a frame against, matching the tone of the " +
              "existing guidelines doc (e.g. 'Destructive actions must use the danger button " +
              "variant, never the primary variant.').",
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
 * Reads a meeting's minutes text and pulls out every concrete, actionable
 * design decision worth considering for the team's guidelines doc.
 * Deliberately does NOT filter against what's already documented -- that
 * judgment (is this a duplicate, an update, or a genuine conflict?) is left
 * to a human, surfaced later by src/guidelinePlacement.ts. Returns an empty
 * list if the notes don't contain any genuine decision (no minimum, never
 * pad).
 */
export async function extractCandidateGuidelines(
  minutesText: string,
  language?: ReviewLanguage
): Promise<CandidateGuideline[]> {
  const anthropic = getClient();

  const languageName = LANGUAGE_NAMES[language ?? "en"];

  const prompt =
    "You are helping a design team turn meeting notes into candidate additions to their " +
    "design guidelines doc, which an automated review tool later checks Figma frames " +
    "against.\n\n" +
    `Here are the meeting minutes to review:\n"""\n${minutesText}\n"""\n\n` +
    "Go through the notes and identify every concrete, actionable design decision the team " +
    "discussed or agreed on -- rules about component usage, layout, color, spacing, " +
    "accessibility, copy, or interaction patterns that a reviewer (human or automated) could " +
    "check a design against. Phrase each as a single clear guideline sentence, not a summary " +
    "of the discussion.\n\n" +
    "Extract every distinct mention as its own candidate, even if it looks similar to, " +
    "duplicates, or contradicts something else in the notes or something the team may already " +
    "have documented elsewhere -- do NOT skip, merge, or silently reconcile these yourself. If " +
    "the same topic is mentioned more than once with different specifics (e.g. different " +
    "numbers or rules), extract each distinct version as its own separate candidate rather " +
    "than picking one -- a human will review the full list and decide which should actually " +
    "apply. Only skip vague chatter, undecided debates, and action items unrelated to design " +
    "rules. If the notes don't contain any concrete decision at all, return an empty list -- " +
    "don't invent one.\n\n" +
    "Write the guideline field in English, always -- it gets saved directly into the " +
    `guidelines file. Write the rationale field entirely in ${languageName}; that field is ` +
    "just for the human reviewing this list, never saved anywhere.";

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
