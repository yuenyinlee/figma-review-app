import fs from "fs";
import path from "path";
import { ReviewPlatform } from "./claude";

/**
 * Static, manually-maintained design-system reference text, replacing what
 * used to be a live Figma fetch + render of every ✅/✴️-marked page on every
 * single review. That mechanism auto-refreshed whenever a checkmark changed
 * in Figma, but its Figma API calls (a page-list lookup plus a render call
 * per page) were a meaningful chunk of each review's latency -- worth
 * trading away for speed and reliability, at the cost of needing a human to
 * update these files when the design system actually changes.
 *
 * Reads straight from disk on every call (no caching) since these are local
 * files bundled with the deployed app -- there's no network round trip to
 * amortize, unlike the Figma calls this replaces.
 */
export function getDesignSystemReference(platform: ReviewPlatform): string | undefined {
  const filePath = path.join(__dirname, "..", `design-system-${platform}.md`);
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}
