export interface GuidelineApplyItem {
  guideline: string;
  section: string;
  isNewSection: boolean;
  /** Set only when the human confirmed this should replace an existing rule instead of being added new. */
  replaceText?: string;
  /**
   * Set when this guideline applies to only one platform -- files it under
   * a "### Web"/"### Mobile" sub-heading within the target section instead
   * of directly under the category. Omit for shared/general guidelines.
   */
  platform?: "web" | "mobile";
}

interface DocSubsection {
  /** "Web" or "Mobile". */
  heading: string;
  headingLine: string;
  bodyLines: string[];
}

interface DocSection {
  heading: string;
  headingLine: string;
  /** Shared/general content directly under this category, before any platform sub-heading. */
  bodyLines: string[];
  /** Platform-specific sub-sections nested under this category, if any. */
  subsections: DocSubsection[];
}

interface ParsedDoc {
  preambleLines: string[];
  sections: DocSection[];
}

const HEADING_PATTERN = /^##(?!#)\s+(.+?)\s*$/;
const SUBHEADING_PATTERN = /^###(?!#)\s+(.+?)\s*$/;
const PLATFORM_LABELS: Record<"web" | "mobile", string> = { web: "Web", mobile: "Mobile" };

function parseGuidelinesDoc(content: string): ParsedDoc {
  const lines = content.split("\n");
  const preambleLines: string[] = [];
  const sections: DocSection[] = [];
  let currentSection: DocSection | null = null;
  let currentSubsection: DocSubsection | null = null;

  for (const line of lines) {
    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch) {
      currentSection = { heading: headingMatch[1], headingLine: line, bodyLines: [], subsections: [] };
      currentSubsection = null;
      sections.push(currentSection);
      continue;
    }

    const subheadingMatch = currentSection ? line.match(SUBHEADING_PATTERN) : null;
    if (subheadingMatch && currentSection) {
      currentSubsection = { heading: subheadingMatch[1], headingLine: line, bodyLines: [] };
      currentSection.subsections.push(currentSubsection);
      continue;
    }

    if (currentSubsection) {
      currentSubsection.bodyLines.push(line);
    } else if (currentSection) {
      currentSection.bodyLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  return { preambleLines, sections };
}

function serializeGuidelinesDoc(doc: ParsedDoc): string {
  const lines = [...doc.preambleLines];
  for (const section of doc.sections) {
    lines.push(section.headingLine, ...section.bodyLines);
    for (const sub of section.subsections) {
      lines.push(sub.headingLine, ...sub.bodyLines);
    }
  }
  return lines.join("\n");
}

function findSection(doc: ParsedDoc, name: string): DocSection | undefined {
  const normalized = name.trim().toLowerCase();
  return doc.sections.find((s) => s.heading.trim().toLowerCase() === normalized);
}

function findSubsection(section: DocSection, name: string): DocSubsection | undefined {
  const normalized = name.trim().toLowerCase();
  return section.subsections.find((s) => s.heading.trim().toLowerCase() === normalized);
}

function lastContentIndex(bodyLines: string[]): number {
  let index = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i].trim() !== "") index = i;
  }
  return index;
}

function ensureTrailingBlankLine(lines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
    lines.push("");
  }
}

interface BulletSpan {
  /** Index of the line starting with "- ". */
  startIndex: number;
  /** Exclusive end index -- one past the last continuation line. */
  endIndex: number;
}

/**
 * A bullet isn't always one line -- a rule can wrap across several lines
 * without a leading "- " on the continuation lines (soft-wrapped within the
 * same list item). Finds each bullet's full span so it can be matched and
 * replaced as a whole, not just its first line.
 */
function findBulletSpans(bodyLines: string[]): BulletSpan[] {
  const spans: BulletSpan[] = [];
  let i = 0;
  while (i < bodyLines.length) {
    if (/^-\s+/.test(bodyLines[i])) {
      const start = i;
      i++;
      while (i < bodyLines.length && bodyLines[i].trim() !== "" && !/^-\s+/.test(bodyLines[i])) {
        i++;
      }
      spans.push({ startIndex: start, endIndex: i });
    } else {
      i++;
    }
  }
  return spans;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getBulletText(bodyLines: string[], span: BulletSpan): string {
  const firstLine = bodyLines[span.startIndex].replace(/^-\s+/, "");
  const rest = bodyLines.slice(span.startIndex + 1, span.endIndex);
  return normalizeWhitespace([firstLine, ...rest].join(" "));
}

/**
 * Inserts a new bullet under the named section (creating it if no existing
 * heading matches -- right before an "Other rules" section if one exists,
 * else at the end). A shared/general guideline (no platform) lands directly
 * under the category, before any platform sub-sections. A platform-specific
 * guideline lands under that category's "### Web"/"### Mobile" sub-heading,
 * creating it if needed.
 */
function insertBulletIntoSection(
  doc: ParsedDoc,
  sectionName: string,
  guideline: string,
  platform?: "web" | "mobile"
): void {
  let section = findSection(doc, sectionName);
  if (!section) {
    section = { heading: sectionName, headingLine: `## ${sectionName}`, bodyLines: [], subsections: [] };
    const otherRulesIndex = doc.sections.findIndex((s) => /other rules/i.test(s.heading));
    if (otherRulesIndex === -1) {
      doc.sections.push(section);
    } else {
      doc.sections.splice(otherRulesIndex, 0, section);
    }
  }

  if (!platform) {
    const insertIndex = lastContentIndex(section.bodyLines) + 1;
    section.bodyLines.splice(insertIndex, 0, `- ${guideline}`);
    if (section.subsections.length > 0) ensureTrailingBlankLine(section.bodyLines);
    return;
  }

  const label = PLATFORM_LABELS[platform];
  const subsection = findSubsection(section, label);
  if (!subsection) {
    const lastBodyLines =
      section.subsections.length > 0 ? section.subsections[section.subsections.length - 1].bodyLines : section.bodyLines;
    ensureTrailingBlankLine(lastBodyLines);
    section.subsections.push({ heading: label, headingLine: `### ${label}`, bodyLines: ["", `- ${guideline}`, ""] });
    return;
  }

  const insertIndex = lastContentIndex(subsection.bodyLines) + 1;
  subsection.bodyLines.splice(insertIndex, 0, `- ${guideline}`);
}

/**
 * Replaces an existing bullet's exact text (found anywhere in the doc --
 * shared content or within any platform sub-section, regardless of
 * whether it wraps across multiple lines) with a new guideline. Compares
 * with whitespace normalized on both sides, since a soft-wrapped bullet's
 * exact line breaks aren't meaningful. Throws if the exact text can't be
 * found, rather than silently doing nothing or guessing which line was
 * meant.
 */
function replaceBulletText(doc: ParsedDoc, oldText: string, newGuideline: string): void {
  const normalizedOld = normalizeWhitespace(oldText);
  const allBodyLineArrays: string[][] = [];
  for (const section of doc.sections) {
    allBodyLineArrays.push(section.bodyLines);
    for (const sub of section.subsections) {
      allBodyLineArrays.push(sub.bodyLines);
    }
  }

  for (const bodyLines of allBodyLineArrays) {
    for (const span of findBulletSpans(bodyLines)) {
      if (getBulletText(bodyLines, span) === normalizedOld) {
        bodyLines.splice(span.startIndex, span.endIndex - span.startIndex, `- ${newGuideline}`);
        return;
      }
    }
  }
  throw new Error(`Couldn't find the exact existing rule to replace: "${oldText}"`);
}

/**
 * Applies a batch of guideline additions/replacements to the guidelines
 * doc's raw text and returns the updated content. Each item either lands
 * as a new bullet under its target section (and platform sub-section, if
 * platform-specific), or -- if the human chose to replace one of the
 * related existing rules -- overwrites that rule's exact text in place.
 */
export function applyUpdatesToDoc(content: string, items: GuidelineApplyItem[]): string {
  const doc = parseGuidelinesDoc(content);
  for (const item of items) {
    if (item.replaceText) {
      replaceBulletText(doc, item.replaceText, item.guideline);
    } else {
      insertBulletIntoSection(doc, item.section, item.guideline, item.platform);
    }
  }
  return serializeGuidelinesDoc(doc);
}
