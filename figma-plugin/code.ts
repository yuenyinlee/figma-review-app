/// <reference types="@figma/plugin-typings" />

// The plugin sandbox is browser-like but not full DOM, so btoa isn't in the
// @figma/plugin-typings lib -- it's genuinely available at runtime though.
declare function btoa(data: string): string;

// No env vars inside the Figma plugin sandbox -- edit this (and
// manifest.json's networkAccess) if the backend ever moves again.
const BACKEND_URL = "https://figma-review-app.onrender.com";

// Node types Figma's Plugin API allows real Dev Mode annotations on.
const ANNOTATABLE_TYPES = new Set<string>([
  "COMPONENT",
  "COMPONENT_SET",
  "ELLIPSE",
  "FRAME",
  "INSTANCE",
  "LINE",
  "POLYGON",
  "RECTANGLE",
  "STAR",
  "TEXT",
  "VECTOR",
]);

// Has children, but they're just constituent path fragments (BOOLEAN_OPERATION)
// or a sealed internal implementation (INSTANCE) -- not individually
// meaningful annotation targets. A single button instance can otherwise
// expand into 3-4 near-duplicate nested-instance/text candidates for what a
// reviewer sees as one element, burying the one that actually has the
// useful metadata under redundant copies of its own internals.
const SKIP_DESCEND_TYPES = new Set<string>(["BOOLEAN_OPERATION", "INSTANCE"]);

// Guardrail against icon-heavy trees blowing up the prompt sent to Claude.
const MAX_CANDIDATE_NODES = 150;

// Claude rejects images with either dimension over 8000px. Mirrors the
// scale-picking logic in src/figma.ts's computeSafeScale -- the plugin just
// gets the frame's real size for free, since it's already selected locally.
const SAFE_TARGET_PX = 7000;
const DEFAULT_SCALE = 2;
const HARD_CAP_PX = 7900;
const MAX_EXPORT_ATTEMPTS = 5;

function computeSafeScale(width: number, height: number): number {
  const largestDimension = Math.max(width, height);
  if (largestDimension <= 0) return 1;
  const safeScale = SAFE_TARGET_PX / largestDimension;
  // No lower floor: staying under Claude's hard 8000px limit always wins
  // over image quality -- a small/compressed image that succeeds beats a
  // "nicer" one the API just rejects outright.
  return Math.min(DEFAULT_SCALE, safeScale);
}

/** Reads width/height straight out of a PNG's IHDR chunk (bytes 16-23). */
function getPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

/**
 * Exports the node as a PNG, verifying the *actual* rendered pixel size
 * rather than trusting the bounding-box estimate -- effects (shadows,
 * blurs) or rotation can make Figma's real render bigger than the node's
 * own absoluteBoundingBox implies. Re-renders smaller if still oversized.
 */
async function exportFrameSafely(root: ExportableRoot, initialScale: number): Promise<Uint8Array> {
  let scale = initialScale;
  let lastDims = { width: 0, height: 0 };

  for (let attempt = 1; attempt <= MAX_EXPORT_ATTEMPTS; attempt++) {
    const bytes = await root.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
    const dims = getPngDimensions(bytes);
    lastDims = dims;
    const largest = Math.max(dims.width, dims.height);
    if (largest <= HARD_CAP_PX) {
      return bytes;
    }
    scale = scale * (HARD_CAP_PX / largest) * 0.95;
  }

  throw new Error(
    `Rendered image is still ${lastDims.width}x${lastDims.height}px after ${MAX_EXPORT_ATTEMPTS} attempts -- too large for Claude to accept.`
  );
}

type ExportableRoot = FrameNode | ComponentNode | ComponentSetNode | InstanceNode | SectionNode;

function isExportableRoot(node: SceneNode): node is ExportableRoot {
  return (
    node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "COMPONENT_SET" ||
    node.type === "INSTANCE" ||
    node.type === "SECTION"
  );
}

interface NodeInfo {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  // Ground truth from the Plugin API, not visual guesswork: whether this
  // layer is really an instance of a component (and if so, whether that
  // component is remote -- i.e. actually published from a library file, as
  // opposed to a one-off component defined locally in this file).
  isComponentInstance: boolean;
  isRemoteComponentInstance?: boolean;
  mainComponentName?: string;
  // Same idea for text: whether it has a bound text style, and whether that
  // style is remote (from a library) or just locally defined.
  textStyleName?: string;
  isRemoteTextStyle?: boolean;
  // For component instances: the visible text found anywhere inside it (e.g.
  // a button's label), pulled up onto the instance's own entry -- since we
  // don't descend into instances individually (see SKIP_DESCEND_TYPES), this
  // is the only way that text reaches the reviewer at all.
  displayText?: string;
}

type AnnotationCategorySlug = "project_brief" | "design_system" | "accessibility_usability";

interface PluginReviewResponse {
  annotations: { nodeId: string; category: AnnotationCategorySlug; comment: string }[];
}

// The three review dimensions the backend tags each critique with, mapped to
// real Figma Dev Mode annotation categories (own label + color) rather than
// a flat, uncategorized list.
const CATEGORY_CONFIG: Record<AnnotationCategorySlug, { label: string; color: AnnotationCategoryColor }> = {
  project_brief: { label: "Project Brief", color: "blue" },
  design_system: { label: "Design System Guidelines", color: "violet" },
  accessibility_usability: { label: "Accessibility & Usability", color: "orange" },
};

/**
 * Looks up each of our three categories by label in the current file,
 * creating any that don't exist yet, so repeated reviews reuse the same
 * categories instead of creating duplicates every run.
 */
async function getOrCreateCategoryIds(): Promise<Record<AnnotationCategorySlug, string>> {
  const existing = await figma.annotations.getAnnotationCategoriesAsync();
  const ids: Partial<Record<AnnotationCategorySlug, string>> = {};

  for (const slug of Object.keys(CATEGORY_CONFIG) as AnnotationCategorySlug[]) {
    const { label, color } = CATEGORY_CONFIG[slug];
    const match = existing.find((c) => c.label.trim().toLowerCase() === label.toLowerCase());
    if (match) {
      ids[slug] = match.id;
    } else {
      const created = await figma.annotations.addAnnotationCategoryAsync({ label, color });
      ids[slug] = created.id;
    }
  }

  return ids as Record<AnnotationCategorySlug, string>;
}

figma.showUI(__html__, { width: 320, height: 440 });

const ACCESS_CODE_STORAGE_KEY = "accessCode";

async function getStoredAccessCode(): Promise<string | undefined> {
  const code = await figma.clientStorage.getAsync(ACCESS_CODE_STORAGE_KEY);
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

// Tell the UI right away whether an access code is already stored, so it
// shows the right view without a visible flash of the wrong one.
getStoredAccessCode().then((code) => {
  figma.ui.postMessage({ type: "init", hasAccessCode: Boolean(code) });
});

/**
 * Collects all visible text found anywhere within a node's subtree (e.g. a
 * button instance's label), since we don't descend into instances
 * individually and would otherwise lose that signal entirely.
 */
function collectDisplayText(node: SceneNode, out: string[]): void {
  if (node.type === "TEXT" && node.characters) {
    out.push(node.characters);
  }
  if ("children" in node) {
    for (const child of (node as SceneNode & { children: readonly SceneNode[] }).children) {
      collectDisplayText(child, out);
    }
  }
}

function findDisplayText(node: SceneNode): string | undefined {
  const parts: string[] = [];
  collectDisplayText(node, parts);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Looks up whether a layer is a real (and real-ly shared) component
 * instance or text style, using the Plugin API's own bookkeeping rather
 * than guessing from pixels.
 */
async function describeNode(
  node: SceneNode
): Promise<
  Pick<
    NodeInfo,
    | "isComponentInstance"
    | "isRemoteComponentInstance"
    | "mainComponentName"
    | "textStyleName"
    | "isRemoteTextStyle"
    | "displayText"
  >
> {
  if (node.type === "INSTANCE") {
    const displayText = findDisplayText(node);
    try {
      const mainComponent = await node.getMainComponentAsync();
      return {
        isComponentInstance: true,
        isRemoteComponentInstance: mainComponent?.remote ?? false,
        mainComponentName: mainComponent?.name,
        displayText,
      };
    } catch {
      return { isComponentInstance: true, displayText };
    }
  }

  if (node.type === "TEXT" && typeof node.textStyleId === "string" && node.textStyleId.length > 0) {
    try {
      const style = await figma.getStyleByIdAsync(node.textStyleId);
      return {
        isComponentInstance: false,
        textStyleName: style?.name,
        isRemoteTextStyle: style?.remote ?? false,
      };
    } catch {
      return { isComponentInstance: false };
    }
  }

  return { isComponentInstance: false };
}

/**
 * Flattens the selected root's descendants into candidate annotation
 * targets, each with its bounding box relative to the root's top-left
 * corner (so Claude can line them up against the exported frame image).
 */
async function flattenCandidates(root: ExportableRoot, frameBox: Rect): Promise<NodeInfo[]> {
  const candidates: NodeInfo[] = [];

  async function visit(node: SceneNode): Promise<void> {
    if (candidates.length >= MAX_CANDIDATE_NODES) return;
    if (node.visible === false) return;

    if (ANNOTATABLE_TYPES.has(node.type) && "absoluteBoundingBox" in node) {
      const box = (node as SceneNode & { absoluteBoundingBox: Rect | null }).absoluteBoundingBox;
      if (box) {
        const meta = await describeNode(node);
        candidates.push({
          id: node.id,
          name: node.name,
          type: node.type,
          x: box.x - frameBox.x,
          y: box.y - frameBox.y,
          width: box.width,
          height: box.height,
          ...meta,
        });
      }
    }

    if (SKIP_DESCEND_TYPES.has(node.type)) return;
    if ("children" in node) {
      for (const child of (node as SceneNode & { children: readonly SceneNode[] }).children) {
        if (candidates.length >= MAX_CANDIDATE_NODES) break;
        await visit(child);
      }
    }
  }

  await visit(root);
  return candidates;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Reading node.annotations back can return entries with both label and
 * labelMarkdown present (one just empty) -- passing that same shape back
 * into the setter trips Figma's "only one of label or labelMarkdown" check.
 * Strip whichever one is actually empty before re-assigning.
 */
function sanitizeAnnotation(a: Annotation): Annotation {
  return {
    ...(a.labelMarkdown ? { labelMarkdown: a.labelMarkdown } : a.label ? { label: a.label } : {}),
    ...(a.properties ? { properties: a.properties } : {}),
    ...(a.categoryId ? { categoryId: a.categoryId } : {}),
  };
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function runReview(): Promise<void> {
  const accessCode = await getStoredAccessCode();
  if (!accessCode) {
    figma.ui.postMessage({ type: "needsAccessCode" });
    return;
  }

  const selection = figma.currentPage.selection;

  if (selection.length !== 1) {
    figma.ui.postMessage({
      type: "error",
      message: "Select exactly one frame, component, instance, or section to review.",
    });
    return;
  }

  const root = selection[0];
  if (!isExportableRoot(root)) {
    figma.ui.postMessage({
      type: "error",
      message: `Can't review a ${root.type.toLowerCase()}. Select a frame, component, instance, or section.`,
    });
    return;
  }

  const frameBox = root.absoluteBoundingBox;
  if (!frameBox) {
    figma.ui.postMessage({ type: "error", message: "Couldn't read that layer's bounds." });
    return;
  }

  figma.ui.postMessage({ type: "status", message: "Collecting layers..." });
  const nodes = await flattenCandidates(root, frameBox);
  if (nodes.length === 0) {
    figma.ui.postMessage({ type: "error", message: "No annotatable layers found in the selection." });
    return;
  }

  figma.ui.postMessage({ type: "status", message: "Rendering frame..." });
  const scale = computeSafeScale(frameBox.width, frameBox.height);
  let imageBytes: Uint8Array;
  try {
    imageBytes = await exportFrameSafely(root, scale);
  } catch (err) {
    figma.ui.postMessage({ type: "error", message: `Failed to render frame: ${describeError(err)}` });
    return;
  }

  figma.ui.postMessage({ type: "status", message: "Asking the review backend..." });
  let result: PluginReviewResponse;
  try {
    const response = await fetch(`${BACKEND_URL}/plugin-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Code": accessCode },
      body: JSON.stringify({
        fileKey: figma.fileKey,
        nodeId: root.id,
        frameImage: uint8ArrayToBase64(imageBytes),
        nodes,
      }),
    });
    if (response.status === 401) {
      await figma.clientStorage.deleteAsync(ACCESS_CODE_STORAGE_KEY);
      figma.ui.postMessage({
        type: "needsAccessCode",
        message: "That access code was rejected -- please re-enter it.",
      });
      return;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    result = (await response.json()) as PluginReviewResponse;
  } catch (err) {
    figma.ui.postMessage({
      type: "error",
      message: `Review request failed: ${describeError(err)}. Is the backend running at ${BACKEND_URL}?`,
    });
    return;
  }

  figma.ui.postMessage({ type: "status", message: "Setting up annotation categories..." });
  const categoryIds = await getOrCreateCategoryIds();

  figma.ui.postMessage({ type: "status", message: "Writing annotations..." });
  const applied: { name: string; categorySlug: string; categoryLabel: string; comment: string }[] = [];
  let failedCount = 0;
  for (const annotation of result.annotations) {
    const node = await figma.getNodeByIdAsync(annotation.nodeId);
    if (!node || !("annotations" in node)) {
      failedCount++;
      continue;
    }
    const annotatable = node as SceneNode & { annotations: Annotation[] };
    annotatable.annotations = [
      ...annotatable.annotations.map(sanitizeAnnotation),
      { label: annotation.comment, categoryId: categoryIds[annotation.category] },
    ];
    applied.push({
      name: node.name,
      categorySlug: annotation.category,
      categoryLabel: CATEGORY_CONFIG[annotation.category]?.label ?? annotation.category,
      comment: annotation.comment,
    });
  }

  figma.ui.postMessage({ type: "done", applied, failedCount });
}

figma.ui.onmessage = (message: { type: string; code?: string }) => {
  if (message.type === "review") {
    runReview().catch((err) => {
      figma.ui.postMessage({ type: "error", message: `Unexpected error: ${describeError(err)}` });
    });
  } else if (message.type === "setAccessCode" && typeof message.code === "string" && message.code.length > 0) {
    figma.clientStorage.setAsync(ACCESS_CODE_STORAGE_KEY, message.code).then(() => {
      figma.ui.postMessage({ type: "accessCodeSaved" });
    });
  }
};
