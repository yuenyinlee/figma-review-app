/// <reference types="@figma/plugin-typings" />

// The plugin sandbox is browser-like but not full DOM, so btoa isn't in the
// @figma/plugin-typings lib -- it's genuinely available at runtime though.
declare function btoa(data: string): string;

// No env vars inside the Figma plugin sandbox -- edit this (and
// manifest.json's networkAccess) if the backend ever moves again.
const BACKEND_URL = "https://figma-review-app.onrender.com";

// Node types worth surfacing as review candidates -- excludes purely
// structural/internal node types not meaningful as their own comment target.
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
// meaningful comment targets. A single button instance can otherwise
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

// The backend posts each critique as a Figma comment directly (the Plugin
// API has no way to create comments, only the REST API does), so it hands
// back what actually happened per item, already labeled for display -- the
// plugin doesn't need its own category-name mapping anymore.
interface PluginReviewResponse {
  comments: {
    nodeId: string;
    category: AnnotationCategorySlug;
    categoryLabel: string;
    elementDescription: string;
    comment: string;
    commentId?: string;
    ok: boolean;
    error?: string;
  }[];
}

figma.showUI(__html__, { width: 320, height: 480 });

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

interface ExistingAnnotation {
  nodeId: string;
  elementDescription: string;
  text: string;
}

/** Existing Dev Mode annotations (design specs designers already wrote on
 * specific layers -- spacing, color, behavior notes, etc.) often carry
 * requirements the review should check the design against, not just our
 * own guidelines/brief. Joins multiple annotations on one layer together. */
function getAnnotationText(annotations: readonly Annotation[]): string | undefined {
  const texts = annotations
    .map((a) => a.label || a.labelMarkdown)
    .filter((t): t is string => Boolean(t && t.trim().length > 0));
  return texts.length > 0 ? texts.join("; ") : undefined;
}

/**
 * Flattens the selected root's descendants into candidate comment
 * targets, each with its bounding box relative to the root's top-left
 * corner (so Claude can line them up against the exported frame image).
 * Also collects any existing annotations found along the way.
 */
async function flattenCandidates(
  root: ExportableRoot,
  frameBox: Rect
): Promise<{ nodes: NodeInfo[]; existingAnnotations: ExistingAnnotation[] }> {
  const candidates: NodeInfo[] = [];
  const existingAnnotations: ExistingAnnotation[] = [];

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

        if ("annotations" in node) {
          const text = getAnnotationText((node as SceneNode & { annotations: readonly Annotation[] }).annotations);
          if (text) {
            existingAnnotations.push({
              nodeId: node.id,
              elementDescription: meta.displayText || node.name,
              text,
            });
          }
        }
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
  return { nodes: candidates, existingAnnotations };
}

interface FlowConnection {
  sourceFrameId: string;
  sourceElementDescription: string;
  destinationFrameId: string;
}

interface FlowReviewResponse {
  comments: {
    nodeId: string;
    category: string;
    categoryLabel: string;
    elementDescription: string;
    comment: string;
    commentId?: string;
    ok: boolean;
    error?: string;
  }[];
}

/** The direct FRAME children of a section are the flow's pages/screens. */
function collectFlowFrames(section: SectionNode): { id: string; name: string }[] {
  return section.children
    .filter((c): c is FrameNode => c.type === "FRAME")
    .map((f) => ({ id: f.id, name: f.name }));
}

/** Recursively finds every CONNECTOR node (FigJam-style arrows, possibly
 * copied into a design file) anywhere within a node's subtree. */
function collectConnectors(node: BaseNode): ConnectorNode[] {
  const found: ConnectorNode[] = [];

  function visit(n: BaseNode): void {
    if (n.type === "CONNECTOR") {
      found.push(n as ConnectorNode);
    }
    if ("children" in n) {
      for (const child of (n as BaseNode & { children: readonly SceneNode[] }).children) {
        visit(child);
      }
    }
  }

  visit(node);
  return found;
}

/**
 * A connector endpoint may be attached directly to a page frame, or to a
 * specific element inside one (e.g. a button) -- either way, walk up until
 * we find which of our page frames it belongs to, and describe what it's
 * actually attached to (the frame itself, or a specific element within it).
 */
async function resolveConnectorEndpoint(
  endpoint: ConnectorEndpoint,
  frameIds: Set<string>
): Promise<{ frameId: string; elementDescription: string } | undefined> {
  if (!("endpointNodeId" in endpoint)) return undefined;

  const node = await figma.getNodeByIdAsync(endpoint.endpointNodeId);
  if (!node) return undefined;

  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT" && !frameIds.has(current.id)) {
    current = "parent" in current ? current.parent : null;
  }
  if (!current || !frameIds.has(current.id)) return undefined;

  const frameId = current.id;
  const sceneNode = node as SceneNode;
  const elementDescription =
    sceneNode.id === frameId ? sceneNode.name : findDisplayText(sceneNode) || sceneNode.name;
  return { frameId, elementDescription };
}

async function runFlowReview(): Promise<void> {
  const accessCode = await getStoredAccessCode();
  if (!accessCode) {
    figma.ui.postMessage({ type: "needsAccessCode" });
    return;
  }

  const selection = figma.currentPage.selection;
  if (selection.length !== 1 || selection[0].type !== "SECTION") {
    figma.ui.postMessage({
      type: "error",
      message: "Select exactly one section containing the flow's frames.",
    });
    return;
  }

  const section = selection[0] as SectionNode;
  const pageFrames = collectFlowFrames(section);
  if (pageFrames.length < 2) {
    figma.ui.postMessage({
      type: "error",
      message: "That section needs at least two frames to review as a flow.",
    });
    return;
  }

  figma.ui.postMessage({ type: "status", message: "Finding connections..." });
  const frameIds = new Set(pageFrames.map((f) => f.id));
  const connectors = collectConnectors(section);
  const connections: FlowConnection[] = [];
  for (const connector of connectors) {
    const start = await resolveConnectorEndpoint(connector.connectorStart, frameIds);
    const end = await resolveConnectorEndpoint(connector.connectorEnd, frameIds);
    if (start && end && start.frameId !== end.frameId) {
      connections.push({
        sourceFrameId: start.frameId,
        sourceElementDescription: start.elementDescription,
        destinationFrameId: end.frameId,
      });
    }
  }

  figma.ui.postMessage({ type: "status", message: `Rendering ${pageFrames.length} frame(s)...` });
  const frames: { nodeId: string; name: string; image: string }[] = [];
  for (const pageFrame of pageFrames) {
    const node = await figma.getNodeByIdAsync(pageFrame.id);
    if (!node || node.type !== "FRAME") continue;
    const box = node.absoluteBoundingBox;
    const scale = box ? computeSafeScale(box.width, box.height) : 1;
    try {
      const bytes = await exportFrameSafely(node, scale);
      frames.push({ nodeId: pageFrame.id, name: pageFrame.name, image: uint8ArrayToBase64(bytes) });
    } catch (err) {
      figma.ui.postMessage({
        type: "error",
        message: `Failed to render frame "${pageFrame.name}": ${describeError(err)}`,
      });
      return;
    }
  }

  figma.ui.postMessage({ type: "status", message: "Asking the review backend..." });
  let result: FlowReviewResponse;
  try {
    const response = await fetch(`${BACKEND_URL}/flow-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Code": accessCode },
      body: JSON.stringify({
        fileKey: figma.fileKey,
        sectionNodeId: section.id,
        frames,
        connections,
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
    result = (await response.json()) as FlowReviewResponse;
  } catch (err) {
    figma.ui.postMessage({
      type: "error",
      message: `Flow review request failed: ${describeError(err)}. Is the backend running at ${BACKEND_URL}?`,
    });
    return;
  }

  const applied = result.comments
    .filter((c) => c.ok)
    .map((c) => ({
      name: c.elementDescription,
      categorySlug: c.category,
      categoryLabel: c.categoryLabel,
      comment: c.comment,
    }));
  const failedCount = result.comments.length - applied.length;

  figma.ui.postMessage({ type: "done", applied, failedCount });
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
  const { nodes, existingAnnotations } = await flattenCandidates(root, frameBox);
  if (nodes.length === 0) {
    figma.ui.postMessage({ type: "error", message: "No reviewable layers found in the selection." });
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
        existingAnnotations,
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

  // The backend already posted each comment to Figma directly -- nothing
  // left to do here but report what happened.
  const applied = result.comments
    .filter((c) => c.ok)
    .map((c) => ({
      name: c.elementDescription,
      categorySlug: c.category,
      categoryLabel: c.categoryLabel,
      comment: c.comment,
    }));
  const failedCount = result.comments.length - applied.length;

  figma.ui.postMessage({ type: "done", applied, failedCount });
}

figma.ui.onmessage = (message: { type: string; code?: string }) => {
  if (message.type === "review") {
    runReview().catch((err) => {
      figma.ui.postMessage({ type: "error", message: `Unexpected error: ${describeError(err)}` });
    });
  } else if (message.type === "reviewFlow") {
    runFlowReview().catch((err) => {
      figma.ui.postMessage({ type: "error", message: `Unexpected error: ${describeError(err)}` });
    });
  } else if (message.type === "setAccessCode" && typeof message.code === "string" && message.code.length > 0) {
    figma.clientStorage.setAsync(ACCESS_CODE_STORAGE_KEY, message.code).then(() => {
      figma.ui.postMessage({ type: "accessCodeSaved" });
    });
  }
};
