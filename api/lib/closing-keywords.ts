/**
 * Detect whether a PR body contains same-repository closing keyword syntax.
 *
 * Supported forms:
 * - Fixes #123
 * - Closes owner/repo#123
 * - Resolves https://github.com/owner/repo/issues/123
 */

interface RepositoryRef {
  owner: string;
  repo: string;
}

const CLOSING_KEYWORD_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+([^\s]+)/gi;

const ISSUE_NUMBER_PATTERN = /^#(\d+)$/;
const QUALIFIED_REFERENCE_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/i;

function stripTrailingPunctuation(token: string): string {
  return token.replace(/[),.;:!?]+$/, "");
}

function stripInlineCode(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      result += text[index];
      index += 1;
      continue;
    }

    let fenceEnd = index;
    while (fenceEnd < text.length && text[fenceEnd] === "`") {
      fenceEnd += 1;
    }
    const delimiter = text.slice(index, fenceEnd);
    const closingIndex = text.indexOf(delimiter, fenceEnd);
    if (closingIndex === -1) {
      // Unclosed inline code: treat remaining content as code.
      break;
    }

    result += " ";
    index = closingIndex + delimiter.length;
  }

  return result;
}

function stripMarkdownCode(body: string): string {
  const lines = body.split(/\r?\n/);
  const nonCodeLines: string[] = [];
  let activeFenceChar: "`" | "~" | null = null;
  let activeFenceLength = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (!activeFenceChar) {
      const openingFenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
      if (openingFenceMatch) {
        activeFenceChar = openingFenceMatch[1][0] as "`" | "~";
        activeFenceLength = openingFenceMatch[1].length;
      } else {
        nonCodeLines.push(line);
      }
      continue;
    }

    const closingFencePattern = new RegExp(
      `^${activeFenceChar}{${activeFenceLength},}\\s*$`
    );
    if (closingFencePattern.test(trimmed)) {
      activeFenceChar = null;
      activeFenceLength = 0;
    }
  }

  // Unclosed fenced blocks are treated as code until end of body.
  return stripInlineCode(nonCodeLines.join("\n"));
}

/**
 * Extract unique same-repo issue numbers referenced by closing keywords.
 * Returns a deduplicated array of issue numbers in the order they appear.
 */
export function extractSameRepoClosingIssueNumbers(
  body: string | null | undefined,
  repository: RepositoryRef
): number[] {
  if (!body) {
    return [];
  }

  const searchableBody = stripMarkdownCode(body);
  const normalizedOwner = repository.owner.toLowerCase();
  const normalizedRepo = repository.repo.toLowerCase();
  const seen = new Set<number>();
  const result: number[] = [];

  for (const match of searchableBody.matchAll(CLOSING_KEYWORD_PATTERN)) {
    const rawTarget = match[1];
    if (!rawTarget) continue;

    const target = stripTrailingPunctuation(rawTarget);
    const simpleMatch = target.match(ISSUE_NUMBER_PATTERN);
    if (simpleMatch) {
      const num = parseInt(simpleMatch[1], 10);
      if (!seen.has(num)) {
        seen.add(num);
        result.push(num);
      }
      continue;
    }

    const qualifiedMatch = target.match(QUALIFIED_REFERENCE_PATTERN);
    if (qualifiedMatch) {
      const [, owner, repo, numStr] = qualifiedMatch;
      if (
        owner.toLowerCase() === normalizedOwner &&
        repo.toLowerCase() === normalizedRepo
      ) {
        const num = parseInt(numStr, 10);
        if (!seen.has(num)) {
          seen.add(num);
          result.push(num);
        }
      }
      continue;
    }

    const urlMatch = target.match(ISSUE_URL_PATTERN);
    if (urlMatch) {
      const [, owner, repo, numStr] = urlMatch;
      if (
        owner.toLowerCase() === normalizedOwner &&
        repo.toLowerCase() === normalizedRepo
      ) {
        const num = parseInt(numStr, 10);
        if (!seen.has(num)) {
          seen.add(num);
          result.push(num);
        }
      }
    }
  }

  return result;
}

export function hasSameRepoClosingKeywordRef(body: string | null | undefined, repository: RepositoryRef): boolean {
  if (!body) {
    return false;
  }

  const searchableBody = stripMarkdownCode(body);
  const normalizedOwner = repository.owner.toLowerCase();
  const normalizedRepo = repository.repo.toLowerCase();

  for (const match of searchableBody.matchAll(CLOSING_KEYWORD_PATTERN)) {
    const rawTarget = match[1];
    if (!rawTarget) continue;

    const target = stripTrailingPunctuation(rawTarget);
    if (ISSUE_NUMBER_PATTERN.test(target)) {
      return true;
    }

    const qualifiedMatch = target.match(QUALIFIED_REFERENCE_PATTERN);
    if (qualifiedMatch) {
      const [, owner, repo] = qualifiedMatch;
      if (
        owner.toLowerCase() === normalizedOwner &&
        repo.toLowerCase() === normalizedRepo
      ) {
        return true;
      }
      continue;
    }

    const urlMatch = target.match(ISSUE_URL_PATTERN);
    if (urlMatch) {
      const [, owner, repo] = urlMatch;
      if (
        owner.toLowerCase() === normalizedOwner &&
        repo.toLowerCase() === normalizedRepo
      ) {
        return true;
      }
    }
  }

  return false;
}
