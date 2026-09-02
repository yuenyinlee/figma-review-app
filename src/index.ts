import "dotenv/config";
import crypto from "crypto";
import path from "path";
import express, { Request, Response } from "express";
import {
  fetchCheckedPages,
  fetchFrameImageBase64,
  fetchNodeImagesBase64,
  fetchProjectBrief,
  fetchProjectBriefOnPage,
  getNodeDimensions,
  parseFigmaLink,
  postFigmaComment,
} from "./figma";
import {
  getDesignAnnotations,
  getNodeBoundAnnotations,
  getUserFlowCritique,
  LabeledImage,
  NodeInfo,
  FlowFrame,
  FlowConnection,
  FlowFrameAnnotation,
  ReviewLanguage,
  ReviewPlatform,
} from "./claude";
import { logReview, listReviews } from "./db";
import { getGuidelines, fetchDriveFileText } from "./guidelines";
import { extractCandidateGuidelines } from "./guidelineExtraction";
import { planGuidelinePlacements } from "./guidelinePlacement";
import { applyGuidelineUpdates } from "./driveWrite";

const app = express();
app.use(express.json({ limit: "15mb" }));

// The Figma plugin's sandbox iframe makes requests with a `null` origin, so
// the default same-origin policy would otherwise block it.
app.use((req: Request, res: Response, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Access-Code");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

function isValidAccessCode(provided: string | undefined, required: string): boolean {
  if (!provided) return false;
  const providedBuf = Buffer.from(provided);
  const requiredBuf = Buffer.from(required);
  // timingSafeEqual throws on mismatched lengths rather than just returning
  // false, so guard that case explicitly.
  if (providedBuf.length !== requiredBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, requiredBuf);
}

// The plugin is published on Figma Community -- our plan only offers Public
// visibility (no Unlisted option), so anyone could find and install it and
// start hitting this backend on our API budget. Require a shared team access
// code on every route except the bare health check and the guidelines-review
// page shell itself (that page has no sensitive data of its own -- it's just
// a form -- and prompts for the code client-side before calling any of the
// actual data endpoints below). Left unset, this fails open so local
// dev/testing is unaffected.
const ACCESS_CODE_EXEMPT_PATHS = ["/", "/guidelines-review"];
app.use((req: Request, res: Response, next) => {
  const requiredCode = process.env.TEAM_ACCESS_CODE;
  if (!requiredCode || ACCESS_CODE_EXEMPT_PATHS.includes(req.path)) {
    return next();
  }
  if (!isValidAccessCode(req.header("X-Access-Code"), requiredCode)) {
    return res.status(401).json({ error: "Missing or invalid access code" });
  }
  next();
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Re-rendering every design-system reference page from scratch on every
// single review was both slow and a major contributor to hitting Figma's
// rate limit (each page needs its own dimension lookup + render call) --
// yet those pages rarely change between reviews. Cache the rendered set per
// platform for a while so a burst of reviews (the common case -- a
// reviewer working through several frames in a row) only pays that cost
// once.
const DESIGN_SYSTEM_REFERENCE_CACHE_TTL_MS = 15 * 60 * 1000;
const designSystemReferenceCache = new Map<ReviewPlatform, { images: LabeledImage[]; fetchedAt: number }>();

/**
 * Fetches every ✅-marked page in the configured design system file (for the
 * given platform) as a labeled reference image, in a single batched Figma
 * request. Web uses DESIGN_SYSTEM_FILE_KEY, mobile uses
 * MOBILE_DESIGN_SYSTEM_FILE_KEY -- which pages count is discovered live from
 * the file itself (see fetchCheckedPages), not a separately maintained list,
 * so a checkmark added/removed/renamed in Figma takes effect within
 * DESIGN_SYSTEM_REFERENCE_CACHE_TTL_MS of the next review. Returns [] if the
 * relevant file key isn't configured, or the file has no ✅-marked pages.
 */
async function fetchDesignSystemReferences(platform: ReviewPlatform): Promise<LabeledImage[]> {
  const cached = designSystemReferenceCache.get(platform);
  if (cached && Date.now() - cached.fetchedAt < DESIGN_SYSTEM_REFERENCE_CACHE_TTL_MS) {
    return cached.images;
  }

  const fileKey =
    platform === "mobile" ? process.env.MOBILE_DESIGN_SYSTEM_FILE_KEY : process.env.DESIGN_SYSTEM_FILE_KEY;
  if (!fileKey) return [];

  const pages = await fetchCheckedPages(fileKey);
  if (pages.length === 0) return [];

  const images = await fetchNodeImagesBase64(
    fileKey,
    pages.map((p) => p.nodeId)
  );

  const references = pages.map((p) => ({ label: p.label, image: images[p.nodeId] }));
  designSystemReferenceCache.set(platform, { images: references, fetchedAt: Date.now() });
  return references;
}

/**
 * Guards against a stale/wrong pasted file link. The plugin can no longer
 * read figma.fileKey directly (it's a private-plugin-only API, unavailable
 * once installed from Community -- see figma-plugin/code.ts), so the user
 * pastes the file's link instead, which they might forget to update after
 * switching files. A totally different or unrelated file either won't have
 * this exact node ID at all, or will have some other node of a very
 * different size sitting at it -- a locally-measured size close to what
 * Figma itself reports for that ID is strong evidence it's the right file.
 */
async function verifyFileMatchesLocalNode(
  fileKey: string,
  nodeId: string,
  localWidth: number,
  localHeight: number
): Promise<string | null> {
  const remote = await getNodeDimensions(fileKey, nodeId);
  if (!remote) {
    return "That frame wasn't found in the file at the pasted link -- paste the current file's link (Share > Copy link) before reviewing.";
  }
  const closeEnough = (a: number, b: number) => Math.abs(a - b) <= Math.max(2, a * 0.02);
  if (!closeEnough(remote.width, localWidth) || !closeEnough(remote.height, localHeight)) {
    return "This frame's size doesn't match the file at the pasted link -- make sure you've pasted the current file's link before reviewing.";
  }
  return null;
}

app.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/reviews", (_req: Request, res: Response) => {
  res.json(listReviews());
});

/**
 * Read-only view of what the backend currently sees as the team's
 * guidelines -- useful for confirming an edit to the Google Doc actually
 * took effect. Editing happens directly in the doc itself, not via this
 * app -- see src/guidelines.ts.
 */
app.get("/guidelines", async (_req: Request, res: Response) => {
  try {
    const content = await getGuidelines();
    return res.json({ content: content ?? "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

app.post("/review", async (req: Request, res: Response) => {
  const { figmaLink, fileKey: rawFileKey, nodeId: rawNodeId } = req.body ?? {};

  let fileKey: string;
  let nodeId: string;

  try {
    if (typeof figmaLink === "string" && figmaLink.trim().length > 0) {
      ({ fileKey, nodeId } = parseFigmaLink(figmaLink.trim()));
    } else if (typeof rawFileKey === "string" && typeof rawNodeId === "string") {
      fileKey = rawFileKey;
      nodeId = rawNodeId;
    } else {
      return res.status(400).json({
        error:
          "Request body must include either a string field 'figmaLink' (a " +
          "\"Copy link to selection\" URL), or 'fileKey' and 'nodeId' strings",
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ error: message });
  }

  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

  try {
    // 1. Fetch the frame as an image from Figma
    console.log(`[review] fetching frame image...`);
    const frame = await fetchFrameImageBase64(fileKey, nodeId);
    console.log(`[review] frame image fetched (${elapsed()})`);

    // 2. Optionally fetch reference images of the design system's pages
    //    (Components, Typography, etc.), if configured in .env -- this
    //    legacy REST endpoint has no platform detection, so it always uses
    //    the web design system.
    console.log(`[review] fetching design system reference images...`);
    const designSystemReferences = await fetchDesignSystemReferences("web");
    console.log(
      `[review] fetched ${designSystemReferences.length} design system reference image(s) (${elapsed()})`
    );

    // 3. Load the team's current design system guidelines, if any are set
    const guidelines = await getGuidelines();

    // 4. Look for a "Project Brief" page in the same file being reviewed
    console.log(`[review] looking for a "Project Brief" page...`);
    const projectBrief = await fetchProjectBrief(fileKey);
    console.log(
      projectBrief
        ? `[review] found project brief (${projectBrief.length} chars) (${elapsed()})`
        : `[review] no "Project Brief" page found, skipping (${elapsed()})`
    );

    // 5. Ask Claude for a set of localized critique points
    console.log(`[review] calling Claude...`);
    const annotations = await getDesignAnnotations({
      frame,
      designSystemReferences,
      guidelines,
      projectBrief,
    });
    console.log(`[review] got ${annotations.length} annotation(s) from Claude (${elapsed()})`);

    // 6. Look up the frame's real size, so each annotation's 0-1 fraction
    //    position can be converted into Figma's node-offset coordinates
    const dims = await getNodeDimensions(fileKey, nodeId);

    // 7. Post one pinned comment per annotation, at its corresponding spot
    console.log(`[review] posting ${annotations.length} comment(s) to Figma...`);
    const commentIds: string[] = [];
    for (const annotation of annotations) {
      const clampedX = Math.min(1, Math.max(0, annotation.x));
      const clampedY = Math.min(1, Math.max(0, annotation.y));
      const offset = dims
        ? { x: clampedX * dims.width, y: clampedY * dims.height }
        : { x: 0, y: 0 };
      const commentId = await postFigmaComment(fileKey, nodeId, annotation.comment, offset);
      commentIds.push(commentId);
    }
    console.log(`[review] done (${elapsed()})`);

    // 8. Log the result
    logReview({
      fileKey,
      nodeId,
      status: "success",
      critique: JSON.stringify(annotations),
      figmaCommentId: commentIds.join(","),
    });

    return res.json({ annotations, figmaCommentIds: commentIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    logReview({
      fileKey,
      nodeId,
      status: "error",
      error: message,
    });

    return res.status(500).json({ error: message });
  }
});

// Figma's Plugin API has no way to create comments -- only the REST API
// does -- so the backend posts them directly rather than handing critiques
// back for the plugin to write itself (unlike the old Dev Mode annotations
// approach, which the team has since decided against in favor of comments).
const CATEGORY_LABELS_BY_LANGUAGE: Record<ReviewLanguage, Record<string, string>> = {
  en: {
    project_brief: "Project Brief",
    design_system: "Design System Guidelines",
    accessibility_usability: "Accessibility & Usability",
    flow_logic: "Flow Logic",
  },
  ja: {
    project_brief: "プロジェクト概要",
    design_system: "デザインシステムガイドライン",
    accessibility_usability: "アクセシビリティ・ユーザビリティ",
    flow_logic: "フローロジック",
  },
  "zh-Hant": {
    project_brief: "專案簡介",
    design_system: "設計系統指南",
    accessibility_usability: "無障礙與易用性",
    flow_logic: "流程邏輯",
  },
  "zh-Hans": {
    project_brief: "项目简介",
    design_system: "设计系统指南",
    accessibility_usability: "无障碍与易用性",
    flow_logic: "流程逻辑",
  },
};

const VALID_LANGUAGES: ReviewLanguage[] = ["en", "ja", "zh-Hant", "zh-Hans"];

function parseLanguage(value: unknown): ReviewLanguage {
  return VALID_LANGUAGES.includes(value as ReviewLanguage) ? (value as ReviewLanguage) : "en";
}

const VALID_PLATFORMS: ReviewPlatform[] = ["web", "mobile"];

function parsePlatform(value: unknown): ReviewPlatform {
  return VALID_PLATFORMS.includes(value as ReviewPlatform) ? (value as ReviewPlatform) : "web";
}

/**
 * Called by the Figma plugin, which runs inside Figma itself. Unlike
 * /review, the plugin already has the rendered frame (via exportAsync) and
 * the frame's own layer tree, so this endpoint takes those directly instead
 * of fetching them from the Figma REST API -- and, after Claude critiques
 * the frame, posts each finding as a comment pinned to the specific layer
 * it's about (tagged with its category and which element it refers to),
 * rather than a generic pin at an x/y coordinate.
 */
app.post("/plugin-review", async (req: Request, res: Response) => {
  const {
    fileKey,
    nodeId,
    frameWidth,
    frameHeight,
    frameImage,
    nodes,
    existingAnnotations,
    pageNodeId,
    language,
    platform,
  } = req.body ?? {};
  const reviewLanguage = parseLanguage(language);
  const reviewPlatform = parsePlatform(platform);

  if (typeof fileKey !== "string" || typeof nodeId !== "string") {
    return res.status(400).json({
      error: "Request body must include string fields 'fileKey' and 'nodeId'",
    });
  }
  if (typeof frameImage !== "string" || frameImage.length === 0) {
    return res.status(400).json({
      error: "Request body must include a base64-encoded PNG string field 'frameImage'",
    });
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return res.status(400).json({
      error: "Request body must include a non-empty 'nodes' array (the frame's candidate layers)",
    });
  }

  if (typeof frameWidth === "number" && typeof frameHeight === "number") {
    const mismatch = await verifyFileMatchesLocalNode(fileKey, nodeId, frameWidth, frameHeight);
    if (mismatch) {
      return res.status(400).json({ error: mismatch });
    }
  }

  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

  try {
    // 1. Optionally fetch reference images of the design system's pages,
    //    from the web or mobile file depending on this frame's platform
    console.log(`[plugin-review] fetching ${reviewPlatform} design system reference images...`);
    const designSystemReferences = await fetchDesignSystemReferences(reviewPlatform);
    console.log(
      `[plugin-review] fetched ${designSystemReferences.length} design system reference image(s) (${elapsed()})`
    );

    // 2. Load the team's current design system guidelines, if any are set
    const guidelines = await getGuidelines();

    // 3. Look for a "Project Brief" section on the SAME PAGE as the frame
    //    being reviewed -- never one that happens to live on a different
    //    page, even in the same file.
    console.log(`[plugin-review] looking for a "Project Brief" section on this page...`);
    const projectBrief =
      typeof pageNodeId === "string" && pageNodeId.length > 0
        ? await fetchProjectBriefOnPage(fileKey, pageNodeId)
        : await fetchProjectBrief(fileKey);
    console.log(
      projectBrief
        ? `[plugin-review] found project brief (${projectBrief.length} chars) (${elapsed()})`
        : `[plugin-review] no "Project Brief" section found, skipping (${elapsed()})`
    );

    // 4. Ask Claude for a set of critique points, each bound to a layer id
    console.log(`[plugin-review] calling Claude...`);
    const annotations = await getNodeBoundAnnotations({
      frame: { base64: frameImage, mediaType: "image/png" },
      nodes: nodes as NodeInfo[],
      designSystemReferences,
      guidelines,
      projectBrief,
      existingAnnotations: Array.isArray(existingAnnotations) ? existingAnnotations : undefined,
      language: reviewLanguage,
      platform: reviewPlatform,
    });
    console.log(
      `[plugin-review] got ${annotations.length} annotation(s) from Claude (${elapsed()})`
    );

    // 5. Post each critique as a comment pinned to the layer it's about,
    //    tagged with its category and a natural description of the element
    //    (Claude's own elementDescription -- much more legible than the raw
    //    layer name/metadata). Each post is independent so one failure
    //    doesn't sink the whole batch.
    console.log(`[plugin-review] posting ${annotations.length} comment(s) to Figma...`);
    const comments: {
      nodeId: string;
      category: string;
      categoryLabel: string;
      elementDescription: string;
      comment: string;
      commentId?: string;
      ok: boolean;
      error?: string;
    }[] = [];
    for (const annotation of annotations) {
      const categoryLabel = CATEGORY_LABELS_BY_LANGUAGE[reviewLanguage][annotation.category] ?? annotation.category;
      const message = `[${categoryLabel}] ${annotation.elementDescription}: ${annotation.comment}`;
      try {
        const commentId = await postFigmaComment(fileKey, annotation.nodeId, message);
        comments.push({
          nodeId: annotation.nodeId,
          category: annotation.category,
          categoryLabel,
          elementDescription: annotation.elementDescription,
          comment: annotation.comment,
          commentId,
          ok: true,
        });
      } catch (err) {
        comments.push({
          nodeId: annotation.nodeId,
          category: annotation.category,
          categoryLabel,
          elementDescription: annotation.elementDescription,
          comment: annotation.comment,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    console.log(`[plugin-review] done (${elapsed()})`);

    // 6. Log the result
    logReview({
      fileKey,
      nodeId,
      status: "success",
      critique: JSON.stringify(annotations),
      annotatedNodeIds: comments.filter((c) => c.ok).map((c) => c.nodeId).join(","),
    });

    return res.json({ comments });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    logReview({
      fileKey,
      nodeId,
      status: "error",
      error: message,
    });

    return res.status(500).json({ error: message });
  }
});

/**
 * Called by the Figma plugin's "Review User Flow" button: reviews a set of
 * connected frames (screens) as a whole -- does the flow fulfill the
 * project brief, and is the sequence itself logical/user-friendly -- as
 * opposed to /plugin-review's single-frame UI/design-system focus.
 * Deliberately doesn't touch design-system references/guidelines.
 */
app.post("/flow-review", async (req: Request, res: Response) => {
  const { fileKey, sectionNodeId, frames, connections, pageNodeId, frameAnnotations, language } = req.body ?? {};
  const reviewLanguage = parseLanguage(language);

  if (typeof fileKey !== "string" || typeof sectionNodeId !== "string") {
    return res.status(400).json({
      error: "Request body must include string fields 'fileKey' and 'sectionNodeId'",
    });
  }
  if (!Array.isArray(frames) || frames.length < 2) {
    return res.status(400).json({
      error: "Request body must include a 'frames' array with at least 2 frames",
    });
  }

  const [firstFrame] = frames;
  if (typeof firstFrame?.nodeId === "string" && typeof firstFrame?.width === "number" && typeof firstFrame?.height === "number") {
    const mismatch = await verifyFileMatchesLocalNode(fileKey, firstFrame.nodeId, firstFrame.width, firstFrame.height);
    if (mismatch) {
      return res.status(400).json({ error: mismatch });
    }
  }

  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

  try {
    // 1. Look for a "Project Brief" section on the SAME PAGE as the section
    //    being reviewed -- never one that happens to live on a different page.
    console.log(`[flow-review] looking for a "Project Brief" section on this page...`);
    const projectBrief =
      typeof pageNodeId === "string" && pageNodeId.length > 0
        ? await fetchProjectBriefOnPage(fileKey, pageNodeId)
        : await fetchProjectBrief(fileKey);
    console.log(
      projectBrief
        ? `[flow-review] found project brief (${projectBrief.length} chars) (${elapsed()})`
        : `[flow-review] no "Project Brief" section found, skipping (${elapsed()})`
    );

    // 2. Ask Claude to judge the flow as a whole
    console.log(`[flow-review] calling Claude with ${frames.length} frame(s)...`);
    type RequestFrame = { nodeId: string; name: string; image: string; width?: number; height?: number };
    const requestFrames = frames as RequestFrame[];
    const flowFrames = requestFrames.map((f) => ({
      nodeId: f.nodeId,
      name: f.name,
      image: { base64: f.image, mediaType: "image/png" as const },
    }));
    const frameDimsById = new Map(
      requestFrames
        .filter((f) => typeof f.width === "number" && typeof f.height === "number")
        .map((f) => [f.nodeId, { width: f.width as number, height: f.height as number }])
    );
    const critiques = await getUserFlowCritique({
      frames: flowFrames,
      connections: Array.isArray(connections) ? (connections as FlowConnection[]) : [],
      projectBrief,
      frameAnnotations: Array.isArray(frameAnnotations) ? (frameAnnotations as FlowFrameAnnotation[]) : undefined,
      language: reviewLanguage,
    });
    console.log(`[flow-review] got ${critiques.length} critique(s) from Claude (${elapsed()})`);

    // 3. Post each critique as a comment pinned to the frame it's about
    console.log(`[flow-review] posting ${critiques.length} comment(s) to Figma...`);
    const comments: {
      nodeId: string;
      category: string;
      categoryLabel: string;
      elementDescription: string;
      comment: string;
      commentId?: string;
      ok: boolean;
      error?: string;
    }[] = [];
    for (const critique of critiques) {
      const categoryLabel = CATEGORY_LABELS_BY_LANGUAGE[reviewLanguage][critique.category] ?? critique.category;
      const message = `[${categoryLabel}] ${critique.elementDescription}: ${critique.comment}`;
      const dims = frameDimsById.get(critique.frameId);
      const clampedX = Math.min(1, Math.max(0, critique.x));
      const clampedY = Math.min(1, Math.max(0, critique.y));
      const offset = dims ? { x: clampedX * dims.width, y: clampedY * dims.height } : { x: 0, y: 0 };
      try {
        const commentId = await postFigmaComment(fileKey, critique.frameId, message, offset);
        comments.push({
          nodeId: critique.frameId,
          category: critique.category,
          categoryLabel,
          elementDescription: critique.elementDescription,
          comment: critique.comment,
          commentId,
          ok: true,
        });
      } catch (err) {
        comments.push({
          nodeId: critique.frameId,
          category: critique.category,
          categoryLabel,
          elementDescription: critique.elementDescription,
          comment: critique.comment,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    console.log(`[flow-review] done (${elapsed()})`);

    // 4. Log the result
    logReview({
      fileKey,
      nodeId: sectionNodeId,
      status: "success",
      critique: JSON.stringify(critiques),
      annotatedNodeIds: comments.filter((c) => c.ok).map((c) => c.nodeId).join(","),
    });

    return res.json({ comments });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    logReview({
      fileKey,
      nodeId: sectionNodeId,
      status: "error",
      error: message,
    });

    return res.status(500).json({ error: message });
  }
});

/**
 * Standalone page for turning meeting minutes into candidate guidelines --
 * not tied to any specific Figma file, so it lives here instead of in the
 * plugin. The page itself has no sensitive data (see the access-code
 * exemption above); its own JS prompts for/stores the code before calling
 * /extract-guidelines or /plan-guideline-updates.
 */
app.get("/guidelines-review", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "..", "public", "guidelines-review.html"));
});

/**
 * Reads a meeting minutes Google Doc and pulls out candidate guidelines --
 * the first step of the semi-automatic guidelines-update flow. Candidates
 * aren't tested against a synthetic mockup (that cost more API calls than
 * it was worth); instead /plan-guideline-updates checks each one against
 * the existing guidelines text directly, and real enforcement is proven
 * out the next time an actual Figma review runs against the updated file.
 */
app.post("/extract-guidelines", async (req: Request, res: Response) => {
  const { minutesDocUrl, language } = req.body ?? {};

  if (typeof minutesDocUrl !== "string" || minutesDocUrl.trim().length === 0) {
    return res.status(400).json({
      error: "Request body must include a non-empty string field 'minutesDocUrl'",
    });
  }

  try {
    const minutesText = await fetchDriveFileText(minutesDocUrl.trim());
    if (minutesText.length === 0) {
      return res.status(400).json({ error: "The meeting minutes document appears to be empty" });
    }

    const candidates = await extractCandidateGuidelines(minutesText, parseLanguage(language));
    return res.json({ candidates });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

/**
 * Given guidelines a human selected from the extracted candidates, decides
 * which existing section of the guidelines doc each belongs under -- or
 * whether it needs a new section -- and lists every existing rule that's
 * similar to or contradicts it, so the human can decide whether to add it
 * alongside those or replace one of them. Read-only, no write yet; the
 * page shows this for review before POSTing to /apply-guideline-updates.
 * See src/guidelinePlacement.ts.
 */
const VALID_CANDIDATE_PLATFORMS = ["web", "mobile", "both"];

app.post("/plan-guideline-updates", async (req: Request, res: Response) => {
  const { candidates, language } = req.body ?? {};

  const valid =
    Array.isArray(candidates) &&
    candidates.length > 0 &&
    candidates.every(
      (c) =>
        c &&
        typeof c.guideline === "string" &&
        c.guideline.length > 0 &&
        VALID_CANDIDATE_PLATFORMS.includes(c.platform)
    );
  if (!valid) {
    return res.status(400).json({
      error:
        "Request body must include a non-empty array 'candidates', each with a non-empty " +
        "string 'guideline' and a 'platform' of 'web', 'mobile', or 'both'",
    });
  }

  try {
    const existingContent = (await getGuidelines()) ?? "";
    const placements = await planGuidelinePlacements(candidates, existingContent, parseLanguage(language));
    return res.json({ placements });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

/**
 * Writes the human-confirmed placement/replacement decisions to the
 * guidelines .md file. See src/driveWrite.ts.
 */
app.post("/apply-guideline-updates", async (req: Request, res: Response) => {
  const { items } = req.body ?? {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      error: "Request body must include a non-empty array 'items'",
    });
  }
  const valid = items.every(
    (item) =>
      item &&
      typeof item.guideline === "string" &&
      typeof item.section === "string" &&
      typeof item.isNewSection === "boolean"
  );
  if (!valid) {
    return res.status(400).json({
      error: "Each item must include string 'guideline', string 'section', and boolean 'isNewSection'",
    });
  }

  try {
    await applyGuidelineUpdates(items);
    return res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Figma review server listening on http://localhost:${PORT}`);
});
