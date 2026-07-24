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
 * regardless of section) with a new guideline -- used when a new guideline
 * supersedes a contradicting existing one. Throws if the exact text can't
 * be found, rather than silently doing nothing or guessing which line was
 * meant.
 */
function replaceBulletText(doc: ParsedDoc, oldText: string, newGuideline: string): void {
  const normalizedOld = oldText.trim();
  for (const section of doc.sections) {
    for (let i = 0; i < section.bodyLines.length; i++) {
      const bulletMatch = section.bodyLines[i].match(/^-\s+(.+?)\s*$/);
      if (bulletMatch && bulletMatch[1].trim() === normalizedOld) {
        section.bodyLines[i] = `- ${newGuideline}`;
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
