export interface GuidelineApplyItem {
  guideline: string;
  section: string;
  isNewSection: boolean;
  /** Set only when the human confirmed this should replace an existing rule instead of being added new. */
  replaceText?: string;
}

interface DocSection {
  heading: string;
  headingLine: string;
  bodyLines: string[];
}

interface ParsedDoc {
  preambleLines: string[];
  sections: DocSection[];
}

const HEADING_PATTERN = /^##(?!#)\s+(.+?)\s*$/;

function parseGuidelinesDoc(content: string): ParsedDoc {
  const lines = content.split("\n");
  const preambleLines: string[] = [];
  const sections: DocSection[] = [];
  let current: DocSection | null = null;

  for (const line of lines) {
    const match = line.match(HEADING_PATTERN);
    if (match) {
      current = { heading: match[1], headingLine: line, bodyLines: [] };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push(line);
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
  }
  return lines.join("\n");
}

function findSection(doc: ParsedDoc, name: string): DocSection | undefined {
  const normalized = name.trim().toLowerCase();
  return doc.sections.find((s) => s.heading.trim().toLowerCase() === normalized);
}

function lastContentIndex(bodyLines: string[]): number {
  let index = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i].trim() !== "") index = i;
  }
  return index;
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
 * Inserts a new bullet under the named section. If no existing heading
 * matches (case/whitespace-insensitive), creates a new section -- right
 * before an "Other rules" section if one exists, else at the end.
 */
function insertBulletIntoSection(doc: ParsedDoc, sectionName: string, guideline: string): void {
  const section = findSection(doc, sectionName);
  if (!section) {
    const newSection: DocSection = {
      heading: sectionName,
      headingLine: `## ${sectionName}`,
      bodyLines: ["", `- ${guideline}`, ""],
    };
    const otherRulesIndex = doc.sections.findIndex((s) => /other rules/i.test(s.heading));
    if (otherRulesIndex === -1) {
      doc.sections.push(newSection);
    } else {
      doc.sections.splice(otherRulesIndex, 0, newSection);
    }
    return;
  }

  const insertIndex = lastContentIndex(section.bodyLines) + 1;
  section.bodyLines.splice(insertIndex, 0, `- ${guideline}`);
}

/**
 * Replaces an existing bullet's exact text (found anywhere in the doc,
 * regardless of section, and regardless of whether it wraps across
 * multiple lines) with a new guideline -- used when a new guideline
 * supersedes a contradicting existing one. Compares with whitespace
 * normalized on both sides, since a soft-wrapped bullet's exact line
 * breaks aren't meaningful. Throws if the exact text can't be found,
 * rather than silently doing nothing or guessing which line was meant.
 */
function replaceBulletText(doc: ParsedDoc, oldText: string, newGuideline: string): void {
  const normalizedOld = normalizeWhitespace(oldText);
  for (const section of doc.sections) {
    for (const span of findBulletSpans(section.bodyLines)) {
      if (getBulletText(section.bodyLines, span) === normalizedOld) {
        section.bodyLines.splice(span.startIndex, span.endIndex - span.startIndex, `- ${newGuideline}`);
        return;
      }
    }
  }
  throw new Error(`Couldn't find the exact existing rule to replace: "${oldText}"`);
}

/**
 * Applies a batch of guideline additions/replacements to the guidelines
 * doc's raw text and returns the updated content. Each item either lands
 * as a new bullet under its target section, or -- if the human chose to
 * replace one of the related existing rules -- overwrites that rule's
 * exact text in place.
 */
export function applyUpdatesToDoc(content: string, items: GuidelineApplyItem[]): string {
  const doc = parseGuidelinesDoc(content);
  for (const item of items) {
    if (item.replaceText) {
      replaceBulletText(doc, item.replaceText, item.guideline);
    } else {
      insertBulletIntoSection(doc, item.section, item.guideline);
    }
  }
  return serializeGuidelinesDoc(doc);
}
