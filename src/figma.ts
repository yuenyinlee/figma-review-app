import fetch from "node-fetch";

const FIGMA_API_BASE = "https://api.figma.com/v1";

// Figma's image render endpoint can be slow for large/complex pages. Without
// a timeout, a stuck render would hang the request forever with no error.
const REQUEST_TIMEOUT_MS = 45_000;

// Claude rejects images with either dimension over 8000px. We look up each
// node's real size and pick the largest scale that stays safely under that.
// We target well under the actual limit because effects like drop shadows
// can extend the rendered PNG past the node's reported bounding box, and
// Figma's own pixel rounding can push things over a tight target.
const MAX_DIMENSION_PX = 8000;
const SAFE_TARGET_PX = 7000;
const DEFAULT_SCALE = 2;
// A little margin under MAX_DIMENSION_PX, and how many times to retry a
// render that still comes out oversized (effects/rotation can make Figma's
// actual render bigger than the bounding-box estimate predicted).
const HARD_CAP_PX = 7900;
const MAX_RENDER_ATTEMPTS = 5;

export interface ImageResult {
  base64: string;
  mediaType: "image/png";
}

function getFigmaToken(): string {
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error("FIGMA_TOKEN is not set in the environment (.env file)");
  }
  return token;
}

/**
 * Parses a Figma "Copy link to selection" URL into a file key + node ID,
 * e.g. https://www.figma.com/design/ABC123/My-File?node-id=1-23
 *   -> { fileKey: "ABC123", nodeId: "1:23" }
 */
export function parseFigmaLink(link: string): { fileKey: string; nodeId: string } {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error(`"${link}" is not a valid URL`);
  }

  const fileKeyMatch = url.pathname.match(/\/(file|design)\/([a-zA-Z0-9]+)/);
  if (!fileKeyMatch) {
    throw new Error(
      'Could not find a file key in that Figma link. Make sure it looks like ' +
        "https://www.figma.com/design/FILE_KEY/... (copied via \"Copy link to selection\")"
    );
  }
  const fileKey = fileKeyMatch[2];

  const nodeIdParam = url.searchParams.get("node-id");
  if (!nodeIdParam) {
    throw new Error(
      'That Figma link doesn\'t include a node-id. In Figma, right-click the ' +
        'frame and choose "Copy link to selection" rather than just copying the ' +
        "browser URL."
    );
  }
  const nodeId = nodeIdParam.replace("-", ":");

  return { fileKey, nodeId };
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * Figma's API occasionally returns a transient 500 ("Internal error, please
 * try again later"), especially when rendering large/complex nodes. Retry a
 * couple of times with a short backoff before giving up.
 */
async function fetchWithRetry(
  url: string,
  options: Parameters<typeof fetch>[1],
  maxAttempts = 3
): Promise<FetchResponse> {
  let res: FetchResponse;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = await fetch(url, options);
    if (res.ok || res.status < 500 || attempt === maxAttempts) {
      return res;
    }
    const delayMs = 2000 * attempt;
    console.log(
      `[figma] got ${res.status} from Figma, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return res!;
}

async function downloadImageBuffer(url: string) {
  const imageRes = await fetch(url, { timeout: REQUEST_TIMEOUT_MS });
  if (!imageRes.ok) {
    throw new Error(`Failed to download rendered image: ${imageRes.status}`);
  }
  return imageRes.buffer();
}

/** Reads width/height straight out of a PNG's IHDR chunk (bytes 16-23). */
function getPngDimensions(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export async function getNodeDimensions(
  fileKey: string,
  nodeId: string
): Promise<{ width: number; height: number } | null> {
  const token = getFigmaToken();
  const url = `${FIGMA_API_BASE}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(
    nodeId
  )}`;

  const res = await fetchWithRetry(url, {
    headers: { "X-Figma-Token": token },
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!res.ok) {
    throw new Error(`Figma node lookup failed: ${res.status} ${await res.text()}`);
  }

  interface NodeBox {
    absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
    children?: NodeBox[];
  }

  const json = (await res.json()) as {
    nodes: Record<string, { document?: NodeBox } | null>;
  };

  const doc = json.nodes[nodeId]?.document;
  if (!doc) return null;

  if (doc.absoluteBoundingBox) {
    return { width: doc.absoluteBoundingBox.width, height: doc.absoluteBoundingBox.height };
  }

  // Pages (CANVAS nodes) have no bounding box of their own -- they're an
  // unbounded surface, not a shape. Derive an effective size instead from
  // the union of their direct children's boxes, so a design-system
  // reference page (rather than a single frame) still gets scaled safely.
  if (doc.children && doc.children.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const child of doc.children) {
      const box = child.absoluteBoundingBox;
      if (!box) continue;
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.width);
      maxY = Math.max(maxY, box.y + box.height);
    }
    if (minX !== Infinity) {
      return { width: maxX - minX, height: maxY - minY };
    }
  }

  return null;
}

/**
 * Lists a file's pages and returns just the ones the team has marked ready
 * for design-system reference by prefixing the page name with "✅" --
 * discovered live on every call, so adding/renaming/removing a checkmark in
 * Figma takes effect on the very next review with no config change needed.
 * Uses depth=1 so this stays a light request (page names only, not each
 * page's full contents).
 */
export async function fetchCheckedPages(fileKey: string): Promise<{ label: string; nodeId: string }[]> {
  const token = getFigmaToken();
  const url = `${FIGMA_API_BASE}/files/${encodeURIComponent(fileKey)}?depth=1`;

  const res = await fetchWithRetry(url, {
    headers: { "X-Figma-Token": token },
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!res.ok) {
    throw new Error(`Figma page list lookup failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    document: { children: { id: string; name: string; type: string }[] };
  };

  return json.document.children
    .filter((child) => child.type === "CANVAS" && child.name.includes("✅"))
    .map((page) => ({ label: page.name.replace(/✅/g, "").trim(), nodeId: page.id }));
}

/**
 * Picks the largest render scale (up to DEFAULT_SCALE) that keeps both
 * image dimensions under Claude's 8000px limit. Falls back to a
 * conservative scale if the node's size can't be determined.
 */
async function computeSafeScale(fileKey: string, nodeId: string): Promise<number> {
  try {
    const dims = await getNodeDimensions(fileKey, nodeId);
    if (!dims || dims.width <= 0 || dims.height <= 0) return 1;

    const largestDimension = Math.max(dims.width, dims.height);
    const safeScale = SAFE_TARGET_PX / largestDimension;
    // No lower floor here: staying under Claude's hard 8000px limit always
    // wins over image quality -- a small/compressed image that succeeds
    // beats a "nicer" one the API just rejects outright.
    const scale = Math.min(DEFAULT_SCALE, safeScale);
    console.log(
      `[figma] node ${nodeId} is ${Math.round(dims.width)}x${Math.round(
        dims.height
      )}px -> using scale ${scale.toFixed(2)}`
    );
    return scale;
  } catch {
    return 1;
  }
}

async function renderNodeUrl(fileKey: string, nodeId: string, scale: number): Promise<string> {
  const token = getFigmaToken();
  const renderUrl = `${FIGMA_API_BASE}/images/${encodeURIComponent(
    fileKey
  )}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`;

  const renderRes = await fetchWithRetry(renderUrl, {
    headers: { "X-Figma-Token": token },
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!renderRes.ok) {
    throw new Error(
      `Figma image render request failed: ${renderRes.status} ${await renderRes.text()}`
    );
  }

  const renderJson = (await renderRes.json()) as {
    images: Record<string, string | null>;
    err?: string;
  };

  if (renderJson.err) {
    throw new Error(`Figma image render error: ${renderJson.err}`);
  }

  const imageUrl = renderJson.images[nodeId];
  if (!imageUrl) {
    throw new Error(
      `Figma did not return an image for node ${nodeId}. Check the file key and node ID.`
    );
  }

  return imageUrl;
}

/**
 * Renders a node and verifies the *actual* rendered pixel size rather than
 * trusting the bounding-box estimate -- effects (shadows, blurs) or
 * rotation can make Figma's real render bigger than computeSafeScale
 * predicted. Re-renders smaller if still oversized.
 */
async function fetchSingleNodeImage(fileKey: string, nodeId: string): Promise<ImageResult> {
  let scale = await computeSafeScale(fileKey, nodeId);

  for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt++) {
    const imageUrl = await renderNodeUrl(fileKey, nodeId, scale);
    const buffer = await downloadImageBuffer(imageUrl);
    const dims = getPngDimensions(buffer);
    const largest = Math.max(dims.width, dims.height);

    if (largest <= HARD_CAP_PX) {
      return { base64: buffer.toString("base64"), mediaType: "image/png" };
    }

    console.log(
      `[figma] node ${nodeId} rendered at ${dims.width}x${dims.height}px (over Claude's limit), retrying smaller`
    );
    scale = scale * (HARD_CAP_PX / largest) * 0.95;
  }

  throw new Error(
    `Could not render node ${nodeId} under Claude's image size limit after ${MAX_RENDER_ATTEMPTS} attempts.`
  );
}

/**
 * Renders one or more Figma nodes (in the same file) as PNGs, each at a
 * scale that's safe for Claude's size limits, and returns them as base64
 * data keyed by node ID.
 */
export async function fetchNodeImagesBase64(
  fileKey: string,
  nodeIds: string[]
): Promise<Record<string, ImageResult>> {
  const results: Record<string, ImageResult> = {};
  for (const nodeId of nodeIds) {
    results[nodeId] = await fetchSingleNodeImage(fileKey, nodeId);
  }
  return results;
}

/**
 * Renders a single Figma node as a PNG and returns it as base64 data,
 * ready to hand to Claude's vision input.
 */
export async function fetchFrameImageBase64(
  fileKey: string,
  nodeId: string
): Promise<ImageResult> {
  return fetchSingleNodeImage(fileKey, nodeId);
}

interface FigmaTreeNode {
  id: string;
  name: string;
  type: string;
  characters?: string;
  children?: FigmaTreeNode[];
}

/**
 * Finds a node whose name starts with the given prefix (case-insensitive) --
 * either a dedicated top-level page (canvas), or a section/frame living on
 * any page. This lets the brief be a whole page, or just a section box
 * dropped on the same page as the designs. Returns null if no match is
 * found -- this feature is optional, so a missing brief just means we skip
 * it.
 */
async function findBriefNodeId(fileKey: string, namePrefix: string): Promise<string | null> {
  const token = getFigmaToken();
  // depth=2 returns every page plus each page's immediate children (top-level
  // frames/sections), which is enough to spot a "Project Brief" section/frame
  // without pulling the full, potentially huge, document tree.
  const url = `${FIGMA_API_BASE}/files/${encodeURIComponent(fileKey)}?depth=2`;

  const res = await fetchWithRetry(url, {
    headers: { "X-Figma-Token": token },
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!res.ok) {
    throw new Error(`Figma file lookup failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    document: { children: FigmaTreeNode[] };
  };

  const lowerPrefix = namePrefix.trim().toLowerCase();
  const matchesName = (node: FigmaTreeNode) =>
    node.name.trim().toLowerCase().startsWith(lowerPrefix);

  for (const page of json.document.children) {
    // A dedicated page named "Project Brief"
    if (page.type === "CANVAS" && matchesName(page)) {
      return page.id;
    }
    // A section or frame named "Project Brief" living on any page
    const child = (page.children ?? []).find(
      (node) => (node.type === "SECTION" || node.type === "FRAME") && matchesName(node)
    );
    if (child) return child.id;
  }

  return null;
}

function collectText(node: FigmaTreeNode, lines: string[]): void {
  if (node.type === "TEXT" && node.characters) {
    lines.push(node.characters);
  }
  if (node.children) {
    for (const child of node.children) {
      collectText(child, lines);
    }
  }
}

/**
 * Fetches the full text content of a page (all TEXT nodes, in document
 * order), joined into one block.
 */
async function getPageTextContent(fileKey: string, pageNodeId: string): Promise<string> {
  const token = getFigmaToken();
  const url = `${FIGMA_API_BASE}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(
    pageNodeId
  )}`;

  const res = await fetchWithRetry(url, {
    headers: { "X-Figma-Token": token },
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!res.ok) {
    throw new Error(`Figma page content lookup failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    nodes: Record<string, { document: FigmaTreeNode } | null>;
  };

  const doc = json.nodes[pageNodeId]?.document;
  if (!doc) return "";

  const lines: string[] = [];
  collectText(doc, lines);
  return lines.join("\n\n").trim();
}

const PROJECT_BRIEF_NAME = "project brief";

/**
 * Looks for something named "Project Brief" (or starting with that phrase)
 * in the given file -- a dedicated page, or a section/frame on any page --
 * and returns its full text content, or undefined if none exists. This lets
 * each project's own Figma file carry its own brief, with no per-project
 * config needed on our end.
 */
export async function fetchProjectBrief(fileKey: string): Promise<string | undefined> {
  const nodeId = await findBriefNodeId(fileKey, PROJECT_BRIEF_NAME);
  if (!nodeId) return undefined;

  const text = await getPageTextContent(fileKey, nodeId);
  return text.length > 0 ? text : undefined;
}

/**
 * Same idea as fetchProjectBrief, but scoped to a single page -- each page
 * gets its own project brief, and a review must never pick up a brief that
 * happens to live on a different page. Fetches that one page's full subtree
 * (no depth limit, unlike the whole-file scan above) and searches it alone.
 */
export async function fetchProjectBriefOnPage(
  fileKey: string,
  pageNodeId: string
): Promise<string | undefined> {
  const token = getFigmaToken();
  const url = `${FIGMA_API_BASE}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(
    pageNodeId
  )}`;

  const res = await fetchWithRetry(url, {
    headers: { "X-Figma-Token": token },
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!res.ok) {
    throw new Error(`Figma page lookup failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    nodes: Record<string, { document: FigmaTreeNode } | null>;
  };

  const page = json.nodes[pageNodeId]?.document;
  if (!page) return undefined;

  const lowerPrefix = PROJECT_BRIEF_NAME.toLowerCase();
  const matchesName = (node: FigmaTreeNode) => node.name.trim().toLowerCase().startsWith(lowerPrefix);

  function findBrief(node: FigmaTreeNode): FigmaTreeNode | null {
    if ((node.type === "SECTION" || node.type === "FRAME") && matchesName(node)) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = findBrief(child);
        if (found) return found;
      }
    }
    return null;
  }

  let briefNode: FigmaTreeNode | null = null;
  for (const child of page.children ?? []) {
    briefNode = findBrief(child);
    if (briefNode) break;
  }
  if (!briefNode) return undefined;

  const lines: string[] = [];
  collectText(briefNode, lines);
  const text = lines.join("\n\n").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Posts a comment on a Figma file, pinned to a specific node at an optional
 * offset (in the node's own coordinate units, i.e. the same units as its
 * width/height) -- defaults to the node's top-left corner.
 * Returns the created comment's ID.
 */
export async function postFigmaComment(
  fileKey: string,
  nodeId: string,
  message: string,
  offset: { x: number; y: number } = { x: 0, y: 0 }
): Promise<string> {
  const token = getFigmaToken();

  const res = await fetch(`${FIGMA_API_BASE}/files/${encodeURIComponent(fileKey)}/comments`, {
    method: "POST",
    headers: {
      "X-Figma-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      client_meta: {
        node_id: nodeId,
        node_offset: offset,
      },
    }),
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!res.ok) {
    throw new Error(
      `Figma post-comment request failed: ${res.status} ${await res.text()}`
    );
  }

  const json = (await res.json()) as { id: string };
  return json.id;
}
