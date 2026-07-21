import "dotenv/config";
import crypto from "crypto";
import express, { Request, Response } from "express";
import {
  fetchFrameImageBase64,
  fetchNodeImagesBase64,
  fetchProjectBrief,
  getNodeDimensions,
  parseFigmaLink,
  postFigmaComment,
} from "./figma";
import { getDesignAnnotations, getNodeBoundAnnotations, LabeledImage, NodeInfo } from "./claude";
import { logReview, listReviews } from "./db";
import { getGuidelines } from "./guidelines";
import { verifyGuideline } from "./guidelineVerification";

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
// code on every route except the bare health check. Left unset, this fails
// open so local dev/testing is unaffected.
app.use((req: Request, res: Response, next) => {
  const requiredCode = process.env.TEAM_ACCESS_CODE;
  if (!requiredCode || req.path === "/") {
    return next();
  }
  if (!isValidAccessCode(req.header("X-Access-Code"), requiredCode)) {
    return res.status(401).json({ error: "Missing or invalid access code" });
  }
  next();
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

/**
 * Parses DESIGN_SYSTEM_PAGES, a comma-separated list of "Label=nodeId" pairs,
 * e.g. "Components=1:23,Typography=4:56". Returns [] if unset.
 */
function parseDesignSystemPages(): { label: string; nodeId: string }[] {
  const raw = process.env.DESIGN_SYSTEM_PAGES;
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, ...rest] = entry.split("=");
      return { label: label.trim(), nodeId: rest.join("=").trim() };
    })
    .filter((entry) => entry.label && entry.nodeId);
}

/**
 * Fetches every configured design system page as a labeled reference image,
 * in a single batched Figma request. Returns [] if DESIGN_SYSTEM_FILE_KEY or
 * DESIGN_SYSTEM_PAGES isn't configured.
 */
async function fetchDesignSystemReferences(): Promise<LabeledImage[]> {
  const fileKey = process.env.DESIGN_SYSTEM_FILE_KEY;
  const pages = parseDesignSystemPages();
  if (!fileKey || pages.length === 0) return [];

  const images = await fetchNodeImagesBase64(
    fileKey,
    pages.map((p) => p.nodeId)
  );

  return pages.map((p) => ({ label: p.label, image: images[p.nodeId] }));
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
    //    (Components, Typography, etc.), if configured in .env
    console.log(`[review] fetching design system reference images...`);
    const designSystemReferences = await fetchDesignSystemReferences();
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
const CATEGORY_LABELS: Record<string, string> = {
  project_brief: "Project Brief",
  design_system: "Design System Guidelines",
  accessibility_usability: "Accessibility & Usability",
};

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
  const { fileKey, nodeId, frameImage, nodes } = req.body ?? {};

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

  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

  try {
    // 1. Optionally fetch reference images of the design system's pages
    console.log(`[plugin-review] fetching design system reference images...`);
    const designSystemReferences = await fetchDesignSystemReferences();
    console.log(
      `[plugin-review] fetched ${designSystemReferences.length} design system reference image(s) (${elapsed()})`
    );

    // 2. Load the team's current design system guidelines, if any are set
    const guidelines = await getGuidelines();

    // 3. Look for a "Project Brief" page in the same file being reviewed
    console.log(`[plugin-review] looking for a "Project Brief" page...`);
    const projectBrief = await fetchProjectBrief(fileKey);
    console.log(
      projectBrief
        ? `[plugin-review] found project brief (${projectBrief.length} chars) (${elapsed()})`
        : `[plugin-review] no "Project Brief" page found, skipping (${elapsed()})`
    );

    // 4. Ask Claude for a set of critique points, each bound to a layer id
    console.log(`[plugin-review] calling Claude...`);
    const annotations = await getNodeBoundAnnotations({
      frame: { base64: frameImage, mediaType: "image/png" },
      nodes: nodes as NodeInfo[],
      designSystemReferences,
      guidelines,
      projectBrief,
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
      const categoryLabel = CATEGORY_LABELS[annotation.category] ?? annotation.category;
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
 * Checks whether a candidate guideline (not yet saved to
 * design-guidelines.md) would actually be enforced by the review pipeline,
 * before committing it: synthesizes a small test mockup that should violate
 * it, runs the real review against it, and reports whether the violation
 * was actually caught. See src/guidelineVerification.ts.
 */
app.post("/verify-guideline", async (req: Request, res: Response) => {
  const { candidateGuideline } = req.body ?? {};

  if (typeof candidateGuideline !== "string" || candidateGuideline.trim().length === 0) {
    return res.status(400).json({
      error: "Request body must include a non-empty string field 'candidateGuideline'",
    });
  }

  try {
    const result = await verifyGuideline(candidateGuideline.trim());
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Figma review server listening on http://localhost:${PORT}`);
});
