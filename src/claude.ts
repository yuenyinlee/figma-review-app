import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set in the environment (.env file)");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

export interface ImageInput {
  base64: string;
  mediaType: "image/png";
}

export interface LabeledImage {
  /** Human-readable label, e.g. "Components" or "Typography" -- shown to Claude. */
  label: string;
  image: ImageInput;
}

export interface CritiqueInput {
  frame: ImageInput;
  /** Optional rendered snapshots of the team's design system pages (Components, Typography, etc.). */
  designSystemReferences?: LabeledImage[];
  /** Optional plain-text guidelines describing how components should be used. */
  guidelines?: string;
  /** Optional project brief/requirements text, specific to the project this frame belongs to. */
  projectBrief?: string;
}

export interface CritiqueAnnotation {
  /** Horizontal position as a fraction of the frame's width (0 = left edge, 1 = right edge). */
  x: number;
  /** Vertical position as a fraction of the frame's height (0 = top edge, 1 = bottom edge). */
  y: number;
  /** The specific, localized critique point at that position. */
  comment: string;
}

const ANNOTATIONS_SCHEMA = {
  type: "object",
  properties: {
    annotations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          x: {
            type: "number",
            description:
              "Horizontal position as a fraction of the frame's width: 0 = left edge, 1 = right edge.",
          },
          y: {
            type: "number",
            description:
              "Vertical position as a fraction of the frame's height: 0 = top edge, 1 = bottom edge.",
          },
          comment: {
            type: "string",
            description:
              "A specific, actionable critique about the UI element or area at this location.",
          },
        },
        required: ["x", "y", "comment"],
        additionalProperties: false,
      },
    },
  },
  required: ["annotations"],
  additionalProperties: false,
} as const;

/**
 * Sends a rendered Figma frame image to Claude and asks for a set of
 * specific, localized critique points -- each tied to an approximate
 * position on the frame -- covering general usability/accessibility
 * heuristics, and, when provided, consistency with the team's design
 * system components, written guidelines, and project brief.
 */
export async function getDesignAnnotations(
  input: CritiqueInput
): Promise<CritiqueAnnotation[]> {
  const anthropic = getClient();

  const content: Anthropic.Messages.ContentBlockParam[] = [
    { type: "text", text: "Frame being reviewed:" },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: input.frame.mediaType,
        data: input.frame.base64,
      },
    },
  ];

  if (input.designSystemReferences && input.designSystemReferences.length > 0) {
    content.push({
      type: "text",
      text: "For reference, here are pages from the team's design system:",
    });
    for (const ref of input.designSystemReferences) {
      content.push(
        { type: "text", text: `Design system page: ${ref.label}` },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: ref.image.mediaType,
            data: ref.image.base64,
          },
        }
      );
    }
  }

  let instructions =
    "You are a senior product designer reviewing a screen from a Figma file. " +
    "Identify 4-8 distinct, specific issues with the design -- covering things " +
    "like visual hierarchy, spacing/alignment, contrast/accessibility, " +
    "consistency, and usability concerns. For each issue, report exactly where " +
    "on the frame it occurs (as an x/y position, each a fraction from 0 to 1 of " +
    "the frame's width/height) and a short, actionable comment about it. Each " +
    "point should be tied to a specific element or area you can actually see, " +
    "not a general remark about the whole screen.";

  if (input.designSystemReferences && input.designSystemReferences.length > 0) {
    const labels = input.designSystemReferences.map((r) => r.label).join(", ");
    instructions +=
      `\n\nYou were also given reference images from the team's design system ` +
      `(${labels}). Explicitly check whether the frame reuses those existing ` +
      "components correctly (rather than reinventing similar-looking elements), " +
      "and flag any deviations in color, spacing, typography, or component usage " +
      "from that system.";
  }

  if (input.guidelines) {
    instructions +=
      "\n\nThe team has also written these design system guidelines. Check the " +
      `frame against them and call out any violations:\n\n"""\n${input.guidelines}\n"""`;
  }

  if (input.projectBrief) {
    instructions +=
      "\n\nHere is the brief/requirements for this specific project. Check whether " +
      "the frame actually meets what's being asked for, and call out anything " +
      `missing or inconsistent with it:\n\n"""\n${input.projectBrief}\n"""`;
  }

  content.push({ type: "text", text: instructions });

  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content }],
      output_config: {
        format: { type: "json_schema", schema: ANNOTATIONS_SCHEMA },
      },
    },
    { timeout: 60_000 }
  );

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response");
  }

  const parsed = JSON.parse(textBlock.text) as { annotations: CritiqueAnnotation[] };
  return parsed.annotations;
}

export interface NodeInfo {
  id: string;
  name: string;
  type: string;
  /** Position and size in pixels, relative to the reviewed frame's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  // Ground truth from the Plugin API (not a visual guess): whether this
  // layer is really an instance of a component, and whether that component
  // is remote (published from a library file) vs. a local one-off.
  isComponentInstance: boolean;
  isRemoteComponentInstance?: boolean;
  mainComponentName?: string;
  // Same idea for text: a bound text style, and whether it's remote.
  textStyleName?: string;
  isRemoteTextStyle?: boolean;
  // For component instances: the visible text found anywhere inside it (a
  // button's label, etc.) -- the plugin doesn't send nested-instance
  // internals as separate candidates, so this is the only way that text
  // reaches the reviewer at all.
  displayText?: string;
}

/**
 * Which review dimension a critique belongs to -- lets the plugin file each
 * annotation under a real, color-coded Figma annotation category instead of
 * a flat, uncategorized list.
 */
export type AnnotationCategorySlug =
  | "project_brief"
  | "design_system"
  | "accessibility_usability";

export interface NodeBoundAnnotation {
  /** The id of the layer (from the provided node list) this critique applies to. */
  nodeId: string;
  category: AnnotationCategorySlug;
  /**
   * A short, natural description of the element (e.g. "button labeled
   * Confirm"), the way a person would refer to it out loud -- not the raw
   * layer name/metadata, which is often meaningless to a reader (e.g.
   * "filled", "role=danger, size=large..."). Claude has full visual context
   * to describe it naturally; our own metadata doesn't.
   */
  elementDescription: string;
  /** The specific, localized critique point for that layer. */
  comment: string;
}

const ANNOTATION_CATEGORY_SLUGS: AnnotationCategorySlug[] = [
  "project_brief",
  "design_system",
  "accessibility_usability",
];

export interface ExistingAnnotation {
  elementDescription: string;
  text: string;
}

export interface NodeBoundCritiqueInput {
  frame: ImageInput;
  /** Candidate layers within the frame that a critique can be attached to. */
  nodes: NodeInfo[];
  designSystemReferences?: LabeledImage[];
  guidelines?: string;
  projectBrief?: string;
  /** Design specs designers already annotated directly on specific layers. */
  existingAnnotations?: ExistingAnnotation[];
}

function buildNodeAnnotationsSchema(nodeIds: string[]) {
  return {
    type: "object",
    properties: {
      annotations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            nodeId: {
              type: "string",
              enum: nodeIds,
              description:
                "The id of the layer (from the provided layer list) this critique applies to.",
            },
            category: {
              type: "string",
              enum: ANNOTATION_CATEGORY_SLUGS,
              description:
                "Which review dimension this critique belongs to: 'project_brief', " +
                "'design_system', or 'accessibility_usability'.",
            },
            elementDescription: {
              type: "string",
              description:
                "A short, natural noun-phrase description of this specific element, the " +
                "way someone would casually refer to it when pointing at it -- e.g. " +
                "'button labeled Confirm', 'page heading', 'search input field'. Not the " +
                "raw layer name or component metadata, and not a full sentence.",
            },
            comment: {
              type: "string",
              description:
                "A specific, actionable critique about the UI element at this layer. " +
                "Keep it to one concise sentence -- state the problem and the fix, " +
                "no preamble or restating what the layer is.",
            },
          },
          required: ["nodeId", "category", "elementDescription", "comment"],
          additionalProperties: false,
        },
      },
    },
    required: ["annotations"],
    additionalProperties: false,
  } as const;
}

/**
 * Same as getDesignAnnotations, but for use by the Figma plugin: instead of
 * an x/y fraction on a flat image, each critique is bound to a specific
 * layer id from the provided candidate list (so the plugin can write a real
 * Dev Mode annotation on that exact layer). The output schema's nodeId is
 * constrained to exactly the ids passed in, so Claude can't invent one.
 */
export async function getNodeBoundAnnotations(
  input: NodeBoundCritiqueInput
): Promise<NodeBoundAnnotation[]> {
  const anthropic = getClient();

  const content: Anthropic.Messages.ContentBlockParam[] = [
    { type: "text", text: "Frame being reviewed:" },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: input.frame.mediaType,
        data: input.frame.base64,
      },
    },
  ];

  if (input.designSystemReferences && input.designSystemReferences.length > 0) {
    content.push({
      type: "text",
      text: "For reference, here are pages from the team's design system:",
    });
    for (const ref of input.designSystemReferences) {
      content.push(
        { type: "text", text: `Design system page: ${ref.label}` },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: ref.image.mediaType,
            data: ref.image.base64,
          },
        }
      );
    }
  }

  const layerList = input.nodes
    .map((n) => {
      const parts = [
        `id="${n.id}"`,
        `name="${n.name}"`,
        `type=${n.type}`,
        `bounds=(x:${Math.round(n.x)}, y:${Math.round(n.y)}, w:${Math.round(n.width)}, h:${Math.round(
          n.height
        )})`,
      ];
      // Text nodes are never component instances -- that concept just
      // doesn't apply to them, so only show the text-style signal for them.
      // Showing both would read as contradictory ("not a component instance"
      // + "uses shared text style") and risks the model conflating the two.
      if (n.type === "TEXT") {
        parts.push(
          n.textStyleName
            ? n.isRemoteTextStyle
              ? `uses shared text style "${n.textStyleName}"`
              : `uses a LOCAL text style "${n.textStyleName}" (not from the design system library)`
            : "no text style applied at all"
        );
      } else if (n.isComponentInstance) {
        parts.push(
          n.isRemoteComponentInstance
            ? `instance of shared library component "${n.mainComponentName ?? "unknown"}"`
            : `instance of a LOCAL component "${n.mainComponentName ?? "unknown"}" (not from the design system library)`
        );
      } else {
        parts.push("not a component instance (a plain layer)");
      }
      if (n.displayText) {
        parts.push(`label="${n.displayText}"`);
      }
      return `- ${parts.join(" ")}`;
    })
    .join("\n");

  let instructions =
    "You are a senior product designer reviewing a screen from a Figma file. " +
    "Below is the list of layers in this frame, each with its id, name, type, " +
    "bounding box in pixels relative to the frame's top-left corner, and " +
    "(for design system checking) whether it's a real instance of a shared " +
    "library component/text style, a local one-off, or not a component at all:\n\n" +
    `${layerList}\n\n` +
    "Systematically go through the layer list above one by one -- don't stop " +
    "as soon as you've found a couple of obvious issues. A screen with many " +
    "distinct layers typically has real issues spread across several of " +
    "them, not concentrated in just the first one or two you happen to " +
    "notice. Identify up to 20 distinct, specific issues with the design -- " +
    "covering things like visual hierarchy, spacing/alignment, contrast/" +
    "accessibility, consistency, and usability concerns. There is no " +
    "minimum -- if, after that systematic pass, the frame genuinely has " +
    "fewer issues (or none at all), report only what's actually there. Never " +
    "invent or pad out issues just to hit a count -- the goal is thorough " +
    "coverage of what's actually there, not a target number. Use the frame " +
    "image together with the bounding boxes above to work out exactly which " +
    "layer each issue belongs to, and report that layer's id, a short natural " +
    "description of the element (see elementDescription below), and a " +
    "concise, one-sentence comment -- get straight to the problem and the fix, " +
    "no preamble, no restating the layer's name or type. Each point should be " +
    "tied to a specific layer you can actually see an issue with, not a " +
    "general remark about the whole screen. If you find more genuine issues " +
    "than the cap allows, prioritize " +
    "\"design_system\" violations first -- report every one of those you find " +
    "before spending remaining budget on \"project_brief\" or " +
    "\"accessibility_usability\" issues.\n\n" +
    "Tag each issue with exactly one category:\n" +
    "- \"accessibility_usability\": general visual hierarchy, spacing/alignment, " +
    "contrast/accessibility, and usability concerns that would apply regardless " +
    "of this specific project or design system. This applies to ANY layer -- " +
    "including ones that aren't shared component instances -- as long as the " +
    "issue itself isn't about reusing (or failing to reuse) the design system.\n" +
    "- \"design_system\": the frame deviates from the team's design system " +
    "reference components or written guidelines" +
    (input.designSystemReferences?.length || input.guidelines
      ? ""
      : " (not applicable here -- none were provided, so don't use this category)") +
    ".\n" +
    "- \"project_brief\": the frame doesn't meet this project's specific brief " +
    "or requirements" +
    (input.projectBrief
      ? ""
      : " (not applicable here -- no brief was provided, so don't use this category)") +
    ".\n\n" +
    "Category precedence: only when the SAME issue could genuinely be framed " +
    "either way -- e.g. a plain layer standing in for a component, where the " +
    "missing styling is exactly the symptom of not reusing the real component " +
    "-- tag it \"design_system\", not \"accessibility_usability\". This does " +
    "not mean every non-instance layer is off-limits for " +
    "\"accessibility_usability\": still raise genuinely separate usability " +
    "issues (spacing, hierarchy, contrast, touch target size, etc.) on any " +
    "layer, whether or not it's a component instance.";

  if (input.designSystemReferences && input.designSystemReferences.length > 0) {
    const labels = input.designSystemReferences.map((r) => r.label).join(", ");
    instructions +=
      `\n\nYou were also given reference images from the team's design system ` +
      `(${labels}). Explicitly check whether the frame reuses those existing ` +
      "components correctly (rather than reinventing similar-looking elements), " +
      "and flag any deviations in color, spacing, typography, or component usage " +
      "from that system. Trust the ground-truth markers in the layer list over " +
      "visual similarity: a layer that visually resembles a design system " +
      "component (e.g. a button or heading) but is marked \"not a component " +
      "instance\", a \"LOCAL component\", or a \"LOCAL text style\" was custom-" +
      "built or copy-pasted instead of reusing the real shared component or " +
      "style -- flag that explicitly as a design_system violation, even though " +
      "it looks correct.";
  }

  instructions +=
    "\n\nBeyond checking whether a layer is a real instance at all, also check " +
    "whether the SPECIFIC VARIANT chosen for each real component instance " +
    "(per its \"instance of shared library component ...\" name above, which " +
    "encodes variant properties like role/state/size) is semantically " +
    "appropriate for its context -- not just visually present. Each " +
    "instance's own label=\"...\" value above (when present) is its actual " +
    "visible text, extracted directly -- use that as the primary source for " +
    "what a button/component says, not just what you can make out in the " +
    "image; a real screen can be dense enough that small labels are easy to " +
    "misread visually. Cross-reference that label against the variant it's " +
    "using. Common violations to look for: a non-destructive action (e.g. " +
    "\"Confirm\", \"Save\", \"OK\", \"Update\") whose variant name contains " +
    "something like \"danger\" or \"destructive\"; a dismissive or secondary " +
    "action (e.g. \"Cancel\", \"Back\") using the same primary/default variant " +
    "as the main affirmative action; two or more instances sharing the exact " +
    "same variant name (e.g. both \"role=default\") sitting adjacent to each " +
    "other as competing actions in the same view/dialog -- that's a strong " +
    "signal only one of them should be primary. A mismatch between a " +
    "component's variant and its actual semantic role is just as much a " +
    "design_system violation as using no real component at all, even though " +
    "every layer involved is a genuine shared instance.";

  if (input.guidelines) {
    instructions +=
      "\n\nThe team has also written these design system guidelines. Check the " +
      `frame against them and call out any violations:\n\n"""\n${input.guidelines}\n"""`;
  }

  if (input.projectBrief) {
    instructions +=
      "\n\nHere is the brief/requirements for this specific project. Check whether " +
      "the frame actually meets what's being asked for, and call out anything " +
      `missing or inconsistent with it:\n\n"""\n${input.projectBrief}\n"""`;
  }

  if (input.existingAnnotations && input.existingAnnotations.length > 0) {
    const annotationsList = input.existingAnnotations
      .map((a) => `- ${a.elementDescription}: "${a.text}"`)
      .join("\n");
    instructions +=
      "\n\nDesigners have already written the following annotations directly on " +
      "specific elements in this frame, documenting exact design details/specs " +
      "(spacing, color, behavior, etc.):\n\n" +
      `${annotationsList}\n\n` +
      "Check whether the actual design genuinely matches what each of these " +
      "specifies, and flag any mismatch as a design_system violation -- these " +
      "are requirements the team already wrote down, not just conventions to " +
      "infer.";
  }

  content.push({ type: "text", text: instructions });

  const nodeIds = input.nodes.map((n) => n.id);
  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 3500,
      messages: [{ role: "user", content }],
      output_config: {
        format: { type: "json_schema", schema: buildNodeAnnotationsSchema(nodeIds) },
      },
    },
    { timeout: 60_000 }
  );

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response");
  }

  const parsed = JSON.parse(textBlock.text) as { annotations: NodeBoundAnnotation[] };
  return parsed.annotations;
}

export interface FlowFrame {
  nodeId: string;
  name: string;
  image: ImageInput;
}

export interface FlowConnection {
  sourceFrameId: string;
  /** What the arrow actually starts from, e.g. "Sign In button", not just the frame. */
  sourceElementDescription: string;
  destinationFrameId: string;
}

export type FlowCategorySlug = "project_brief" | "flow_logic";

export interface FlowCritique {
  /** The id of the frame (from the provided frame list) this critique applies to. */
  frameId: string;
  category: FlowCategorySlug;
  elementDescription: string;
  comment: string;
}

export interface FlowCritiqueInput {
  frames: FlowFrame[];
  connections: FlowConnection[];
  projectBrief?: string;
}

const FLOW_CATEGORY_SLUGS: FlowCategorySlug[] = ["project_brief", "flow_logic"];

function buildFlowCritiqueSchema(frameIds: string[]) {
  return {
    type: "object",
    properties: {
      critiques: {
        type: "array",
        items: {
          type: "object",
          properties: {
            frameId: {
              type: "string",
              enum: frameIds,
              description: "The id of the frame (from the provided frame list) this critique applies to.",
            },
            category: {
              type: "string",
              enum: FLOW_CATEGORY_SLUGS,
              description:
                "'project_brief' if the flow doesn't meet the project brief, or 'flow_logic' if " +
                "the sequence itself is illogical/confusing/not user-friendly, independent of the brief.",
            },
            elementDescription: {
              type: "string",
              description:
                "A short, natural noun-phrase description of what this critique is about -- e.g. " +
                "'the Sign In button', 'the Dashboard screen', 'the checkout step'. Not a full sentence.",
            },
            comment: {
              type: "string",
              description:
                "A specific, actionable critique. Keep it to one or two concise sentences -- state " +
                "the problem and the fix.",
            },
          },
          required: ["frameId", "category", "elementDescription", "comment"],
          additionalProperties: false,
        },
      },
    },
    required: ["critiques"],
    additionalProperties: false,
  } as const;
}

/**
 * Reviews a user flow -- multiple connected frames/screens -- for whether
 * the overall sequence fulfills the project brief and is logical/user-
 * friendly, as opposed to the per-frame review's UI/design-system focus.
 * Deliberately doesn't take design-system references/guidelines: this mode
 * is scoped to flow/IA logic, not visual detail, per the team's explicit
 * split between the two review modes.
 */
export async function getUserFlowCritique(input: FlowCritiqueInput): Promise<FlowCritique[]> {
  const anthropic = getClient();

  const content: Anthropic.Messages.ContentBlockParam[] = [];
  for (const frame of input.frames) {
    content.push(
      { type: "text", text: `Frame "${frame.name}" (id: ${frame.nodeId}):` },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: frame.image.mediaType,
          data: frame.image.base64,
        },
      }
    );
  }

  const connectionsList =
    input.connections.length > 0
      ? input.connections
          .map((c) => {
            const source = input.frames.find((f) => f.nodeId === c.sourceFrameId);
            const dest = input.frames.find((f) => f.nodeId === c.destinationFrameId);
            return `- "${source?.name ?? c.sourceFrameId}" -- (${c.sourceElementDescription}) --> "${
              dest?.name ?? c.destinationFrameId
            }"`;
          })
          .join("\n")
      : "(no connections between these frames were detected)";

  let instructions =
    "You are a senior product designer reviewing a multi-screen user flow " +
    "from a Figma file. Above are the frames (screens) that make up this " +
    "flow, in no particular order. Here is how they connect to each other " +
    "(which element on one screen navigates to which other screen):\n\n" +
    `${connectionsList}\n\n` +
    "Judge the flow as a whole: does the sequence make logical sense (no " +
    "dead ends, no missing steps, sensible ordering), and is it genuinely " +
    "user-friendly (clear next actions, a reasonable number of steps, " +
    "sensible handling of what happens at each transition)? Systematically " +
    "consider every frame and every connection above, not just the first " +
    "screen you happen to look at. Identify up to 15 distinct, specific " +
    "issues. There is no minimum -- if the flow genuinely has fewer issues " +
    "(or none), report only what's actually there; never invent or pad out " +
    "issues just to hit a count. For each issue, report which frame it's " +
    "most relevant to (by id), a short natural description of what it's " +
    "about, and a concise one-to-two-sentence comment stating the problem " +
    "and the fix.\n\n" +
    "Tag each issue with exactly one category:\n" +
    "- \"flow_logic\": the sequence itself is illogical, confusing, has " +
    "dead ends or missing steps, or isn't user-friendly -- independent of " +
    "any written brief.\n" +
    "- \"project_brief\": the flow doesn't fulfill this project's specific " +
    "brief or requirements" +
    (input.projectBrief
      ? ""
      : " (not applicable here -- no brief was provided, so don't use this category)") +
    ".";

  if (input.projectBrief) {
    instructions +=
      "\n\nHere is the brief/requirements for this project. Check whether " +
      "the flow actually accomplishes what's being asked for, and call out " +
      `anything missing or inconsistent with it:\n\n"""\n${input.projectBrief}\n"""`;
  }

  content.push({ type: "text", text: instructions });

  const frameIds = input.frames.map((f) => f.nodeId);
  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 3000,
      messages: [{ role: "user", content }],
      output_config: {
        format: { type: "json_schema", schema: buildFlowCritiqueSchema(frameIds) },
      },
    },
    { timeout: 90_000 }
  );

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response");
  }

  const parsed = JSON.parse(textBlock.text) as { critiques: FlowCritique[] };
  return parsed.critiques;
}
