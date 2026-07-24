import sharp from "sharp";
import {
  getClient,
  MODEL,
  getNodeBoundAnnotations,
  NodeInfo,
  NodeBoundAnnotation,
  ReviewLanguage,
  LANGUAGE_NAMES,
} from "./claude";
import { getGuidelines } from "./guidelines";

/**
 * A candidate guideline can't be "tested" against text alone -- our review
 * pipeline is vision-based. So we ask Claude to invent a tiny synthetic
 * mockup that should clearly violate the guideline, combining rendering
 * fields (so we can actually draw it) with the same ground-truth fields
 * NodeInfo already defines (so instance/style-based guidelines, not just
 * visual ones, can be tested too).
 */
interface MockNodeSpec extends NodeInfo {
  /** Hex fill color for this node's rectangle, if it should be drawn as a shape. */
  fill?: string;
  /** Literal label text to render centered on this node, if any. */
  text?: string;
  textColor?: string;
  fontSize?: number;
}

interface MockupScenario {
  /**
   * Whether this guideline concerns something a single static image + layer
   * metadata can actually show (appearance, layout, component/style usage,
   * text content, color, spacing) as opposed to behavior over time or
   * interaction (animation, hover/focus states, multi-step flows, backend
   * logic), which a static mockup structurally cannot depict.
   */
  testable: boolean;
  /** If testable is false, why -- shown to the user instead of a fake result. */
  untestableReason?: string;
  canvasWidth?: number;
  canvasHeight?: number;
  backgroundColor?: string;
  nodes?: MockNodeSpec[];
}

const SCENARIO_SCHEMA = {
  type: "object",
  properties: {
    testable: {
      type: "boolean",
      description:
        "Whether this guideline concerns static appearance/structure (colors, spacing, " +
        "component/style usage, layout, text content) that a single rendered image plus " +
        "layer metadata can actually show. Set to false for anything requiring behavior " +
        "over time or interaction -- animation, transitions, hover/focus/loading states, " +
        "multi-step flows, backend logic, copy tone, etc.",
    },
    untestableReason: {
      type: "string",
      description: "If testable is false, a brief explanation why (one sentence).",
    },
    canvasWidth: { type: "number", description: "Canvas width in pixels, under 800. Required if testable." },
    canvasHeight: { type: "number", description: "Canvas height in pixels, under 600. Required if testable." },
    backgroundColor: { type: "string", description: "Hex background color, e.g. #ffffff." },
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: {
            type: "string",
            description: "A plausible Figma node type, e.g. RECTANGLE, TEXT, INSTANCE, FRAME.",
          },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          fill: { type: "string", description: "Hex fill color to draw this node with, if it's a shape." },
          text: { type: "string", description: "Literal label text to render on this node, if any." },
          textColor: { type: "string" },
          fontSize: { type: "number" },
          isComponentInstance: {
            type: "boolean",
            description: "Ground truth: is this really an instance of a shared component?",
          },
          isRemoteComponentInstance: {
            type: "boolean",
            description: "If isComponentInstance, is that component published from a library (vs. a local one-off)?",
          },
          mainComponentName: { type: "string", description: "Name of the component this instance uses, if any." },
          textStyleName: { type: "string", description: "Name of the bound text style, if this is text with one." },
          isRemoteTextStyle: {
            type: "boolean",
            description: "If textStyleName is set, is that style published from a library (vs. local)?",
          },
        },
        required: ["id", "name", "type", "x", "y", "width", "height", "isComponentInstance"],
        additionalProperties: false,
      },
    },
  },
  required: ["testable"],
  additionalProperties: false,
} as const;

/**
 * Asks Claude to invent a minimal synthetic mockup that clearly violates the
 * given candidate guideline -- a targeted unit test scene, not a realistic
 * screen. First checks whether the guideline is even the kind of thing a
 * static image can show at all (see `testable` on MockupScenario) -- without
 * this, a guideline about something like animation timing gets "tested" by
 * literally writing the violation as a caption and reading it back, which
 * looks like a pass but proves nothing about real detection.
 */
async function generateMockupScenario(
  candidateGuideline: string,
  language?: ReviewLanguage
): Promise<MockupScenario> {
  const anthropic = getClient();

  const languageName = LANGUAGE_NAMES[language ?? "en"];

  const prompt =
    "You are creating a tiny synthetic test mockup to verify whether an " +
    "automated design-review tool actually catches a specific guideline " +
    "violation, before that guideline gets added to the team's real " +
    "guidelines file.\n\n" +
    `Candidate guideline to test:\n"""\n${candidateGuideline}\n"""\n\n` +
    "First decide: can this guideline actually be tested by a single static " +
    "rendered image plus layer metadata (appearance, layout, component/style " +
    "usage, text content, color, spacing)? If it concerns behavior over time " +
    "or interaction instead -- animation, transitions, hover/focus/loading " +
    "states, multi-step flows, backend logic, copy tone, etc. -- set " +
    "testable to false and briefly explain why in untestableReason; don't " +
    "try to fake it by writing the violation as a caption/label that just " +
    "states the problem in words. Only proceed to build a mockup if it's " +
    "genuinely testable this way.\n\n" +
    "If testable, invent a minimal, plausible UI mockup -- just a handful of " +
    "simple shapes and labels, not a full screen -- that clearly and " +
    "unambiguously VIOLATES this guideline (through its actual appearance/" +
    "structure, not through text describing the violation). Describe each " +
    "element as a node with its position/size in pixels, a fill color, an " +
    "optional text label, and the ground-truth metadata a real design tool " +
    "would report for it: whether it's a real shared component instance " +
    "(isComponentInstance, isRemoteComponentInstance, mainComponentName) " +
    "and/or has a bound shared text style (textStyleName, isRemoteTextStyle). " +
    "Set these fields to whatever values make the scenario a clear violation " +
    "-- e.g. if the guideline is about component reuse, mark the offending " +
    "element as NOT " +
    "a component instance; if it's about variant or color choice, give it a " +
    "plausible mainComponentName and a fill color/label that make the " +
    "mismatch visually obvious. Keep the canvas small and the violation " +
    "isolated -- don't add unrelated elements or issues.\n\n" +
    `Write the untestableReason field, if used, entirely in ${languageName}.`;

  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: { type: "json_schema", schema: SCENARIO_SCHEMA },
      },
    },
    { timeout: 60_000 }
  );

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response while generating the test scenario");
  }

  const scenario = JSON.parse(textBlock.text) as MockupScenario;
  if (scenario.testable && (!scenario.nodes || scenario.nodes.length === 0)) {
    throw new Error("Claude did not generate any mockup nodes to test against");
  }
  return scenario;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const MAX_CANVAS_DIM = 1600;

/**
 * Builds an SVG string from the scenario and strips the render-only fields
 * back off to get a plain NodeInfo[], the same shape the real plugin sends.
 */
function buildSvg(scenario: MockupScenario): { svg: string; nodes: NodeInfo[] } {
  const canvasWidth = clamp(scenario.canvasWidth ?? 400, 100, MAX_CANVAS_DIM);
  const canvasHeight = clamp(scenario.canvasHeight ?? 300, 100, MAX_CANVAS_DIM);
  const background = scenario.backgroundColor ?? "#ffffff";

  const shapeParts: string[] = [];
  const nodes: NodeInfo[] = [];

  for (const node of scenario.nodes ?? []) {
    const x = clamp(node.x, 0, canvasWidth);
    const y = clamp(node.y, 0, canvasHeight);
    const width = clamp(node.width, 1, Math.max(1, canvasWidth - x));
    const height = clamp(node.height, 1, Math.max(1, canvasHeight - y));

    if (node.fill) {
      shapeParts.push(
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escapeXml(node.fill)}" />`
      );
    }
    if (node.text) {
      const fontSize = node.fontSize ?? 16;
      const textColor = node.textColor ?? "#000000";
      const textX = x + width / 2;
      const textY = y + height / 2 + fontSize * 0.35;
      shapeParts.push(
        `<text x="${textX}" y="${textY}" font-size="${fontSize}" fill="${escapeXml(
          textColor
        )}" font-family="Arial, sans-serif" text-anchor="middle">${escapeXml(node.text)}</text>`
      );
    }

    nodes.push({
      id: node.id,
      name: node.name,
      type: node.type,
      x,
      y,
      width,
      height,
      isComponentInstance: node.isComponentInstance,
      isRemoteComponentInstance: node.isRemoteComponentInstance,
      mainComponentName: node.mainComponentName,
      textStyleName: node.textStyleName,
      isRemoteTextStyle: node.isRemoteTextStyle,
    });
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">` +
    `<rect x="0" y="0" width="${canvasWidth}" height="${canvasHeight}" fill="${escapeXml(background)}" />` +
    shapeParts.join("") +
    `</svg>`;

  return { svg, nodes };
}

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    passed: {
      type: "boolean",
      description: "Whether the tool's output actually caught a violation of this specific guideline.",
    },
    reasoning: { type: "string", description: "Brief explanation for the verdict." },
    matchingComment: {
      type: "string",
      description: "The specific annotation comment that addresses the guideline, if passed is true.",
    },
  },
  required: ["passed", "reasoning"],
  additionalProperties: false,
} as const;

interface JudgeResult {
  passed: boolean;
  reasoning: string;
  matchingComment?: string;
}

/**
 * Asks Claude whether the review pipeline's actual output caught the
 * specific violation the mockup was built for -- a strict check, since a
 * vaguely-related comment shouldn't count as a pass.
 */
async function judgeVerification(
  candidateGuideline: string,
  annotations: NodeBoundAnnotation[],
  language?: ReviewLanguage
): Promise<JudgeResult> {
  const anthropic = getClient();

  const annotationsText =
    annotations.length > 0
      ? annotations.map((a, i) => `${i + 1}. [${a.category}] ${a.comment}`).join("\n")
      : "(no annotations were produced)";

  const languageName = LANGUAGE_NAMES[language ?? "en"];

  const prompt =
    "A design-review tool was tested against a synthetic mockup built " +
    "specifically to violate this candidate guideline:\n\n" +
    `"""\n${candidateGuideline}\n"""\n\n` +
    `Here is what the tool actually flagged:\n\n${annotationsText}\n\n` +
    "Did the tool's output actually catch a violation of this specific " +
    "guideline (not just any issue)? Be strict -- a vaguely related comment " +
    "doesn't count as a pass.\n\n" +
    `Write the reasoning field entirely in ${languageName}.`;

  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: { type: "json_schema", schema: JUDGE_SCHEMA },
      },
    },
    { timeout: 30_000 }
  );

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response while judging the verification");
  }

  return JSON.parse(textBlock.text) as JudgeResult;
}

export interface GuidelineVerificationResult {
  /**
   * true/false = the guideline was actually tested and caught/missed. null =
   * this guideline concerns something a static image can't depict at all
   * (e.g. animation, interaction) -- not tested, not a pass or a fail.
   */
  passed: boolean | null;
  reasoning: string;
  matchingComment?: string;
  annotations: NodeBoundAnnotation[];
}

/**
 * Verifies whether a candidate guideline (not yet saved to
 * design-guidelines.md) would actually be enforced: generates a synthetic
 * mockup that should violate it, runs it through the real review pipeline
 * (combined with the current guidelines file, as it would look post-update),
 * and has Claude judge whether the violation was actually caught.
 */
export async function verifyGuideline(
  candidateGuideline: string,
  language?: ReviewLanguage
): Promise<GuidelineVerificationResult> {
  const scenario = await generateMockupScenario(candidateGuideline, language);

  if (!scenario.testable) {
    return {
      passed: null,
      reasoning:
        scenario.untestableReason ??
        "This guideline can't be verified from a static rendered frame -- it concerns " +
          "behavior over time or interaction rather than static appearance/structure.",
      annotations: [],
    };
  }

  const { svg, nodes } = buildSvg(scenario);

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const mockupImageBase64 = pngBuffer.toString("base64");

  const existingGuidelines = await getGuidelines();
  const combinedGuidelines = [existingGuidelines, candidateGuideline].filter(Boolean).join("\n\n");

  const annotations = await getNodeBoundAnnotations({
    frame: { base64: mockupImageBase64, mediaType: "image/png" },
    nodes,
    guidelines: combinedGuidelines,
    language,
  });

  const judgment = await judgeVerification(candidateGuideline, annotations, language);

  return {
    passed: judgment.passed,
    reasoning: judgment.reasoning,
    matchingComment: judgment.matchingComment,
    annotations,
  };
}
