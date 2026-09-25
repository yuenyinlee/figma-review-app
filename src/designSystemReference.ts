import fs from "fs";
import path from "path";
import { ReviewPlatform } from "./claude";
import { fetchDriveFileText } from "./guidelines";

interface DesignSystemSource {
  link: string;
  label?: string;
}

/**
 * Parses one link per line out of design-system-{platform}.md, each
 * optionally followed by " - Label". Blank lines, the intro comment block,
 * and anything not matching a Drive link are ignored.
 */
function parseSources(fileContent: string): DesignSystemSource[] {
  const sources: DesignSystemSource[] = [];
  for (const line of fileContent.split("\n")) {
    const match = line.match(/(https:\/\/drive\.google\.com\/\S+)(?:\s*-\s*(.+))?/);
    if (!match) continue;
    sources.push({ link: match[1], label: match[2]?.trim() });
  }
  return sources;
}

/**
 * Fetches the team's design-system reference for the given platform, live,
 * from whichever Google Drive docs are listed in design-system-{platform}.md
 * -- no caching, so an edit to any of those docs takes effect on the very
 * next review, same as the separate guidelines doc. Fetches are done in
 * parallel (network-bound, not CPU-bound, so this stays fast even with many
 * sources); a source that fails to fetch is skipped with a warning rather
 * than failing the whole review, since one unshared/deleted doc shouldn't
 * block reviewing against everything else.
 */
export async function getDesignSystemReference(platform: ReviewPlatform): Promise<string | undefined> {
  const filePath = path.join(__dirname, "..", `design-system-${platform}.md`);
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  const sources = parseSources(fileContent);
  if (sources.length === 0) return undefined;

  const fetched = await Promise.allSettled(sources.map((s) => fetchDriveFileText(s.link)));

  const sections: string[] = [];
  fetched.forEach((result, i) => {
    if (result.status === "fulfilled" && result.value.length > 0) {
      const label = sources[i].label;
      sections.push(label ? `## ${label}\n\n${result.value}` : result.value);
    } else if (result.status === "rejected") {
      console.log(
        `[designSystemReference] skipping ${sources[i].label ?? sources[i].link}: ${result.reason}`
      );
    }
  });

  return sections.length > 0 ? sections.join("\n\n---\n\n") : undefined;
}
