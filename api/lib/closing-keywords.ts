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

const ISSUE_NUMBER_PATTERN = /^#\d+$/;
const QUALIFIED_REFERENCE_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#\d+$/;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+$/i;

function stripTrailingPunctuation(token: string): string {
  return token.replace(/[),.;:!?]+$/, "");
}

function stripMarkdownCode(body: string): string {
  return body
    // Remove fenced code blocks (```...``` and ~~~...~~~)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    // Remove inline code spans (`...`)
    .replace(/`[^`]*`/g, " ");
}

/**
 * Extract same-repo issue numbers referenced by closing keywords.
 *
 * Returns deduplicated issue numbers in the order they appear.
 * Only includes same-repo references (bare #N, qualified owner/repo#N,
 * or full GitHub URL pointing to the same owner/repo).
 */
export function extractSameRepoClosingIssueNumbers(body: string | null | undefined, repository: RepositoryRef): number[] {
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

    if (ISSUE_NUMBER_PATTERN.test(target)) {
      const num = parseInt(target.slice(1), 10);
      if (!seen.has(num)) {
        seen.add(num);
        result.push(num);
      }
      continue;
    }

    const qualifiedMatch = target.match(QUALIFIED_REFERENCE_PATTERN);
    if (qualifiedMatch) {
      const [, owner, repo] = qualifiedMatch;
      if (
        owner.toLowerCase() === normalizedOwner &&
        repo.toLowerCase() === normalizedRepo
      ) {
        const num = parseInt(target.split("#")[1], 10);
        if (!seen.has(num)) {
          seen.add(num);
          result.push(num);
        }
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
        const num = parseInt(target.split("/").pop()!, 10);
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
