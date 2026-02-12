/**
 * Detect whether PR body text contains a closing-keyword reference
 * for the current repository (or an unqualified local #N reference).
 *
 * This is a heuristic for webhook guards, not a replacement for
 * GitHub's canonical closingIssuesReferences parsing.
 */
export function hasClosingKeywordForRepo(
  body: string | null | undefined,
  owner: string,
  repo: string
): boolean {
  if (!body) {
    return false;
  }

  const matchClosingReference =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(?:(?:https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+))|(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+))|(?:#(\d+)))/gi;

  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();

  for (const match of body.matchAll(matchClosingReference)) {
    const localIssueNumber = match[7];
    if (localIssueNumber) {
      return true;
    }

    const urlOwner = match[1];
    const urlRepo = match[2];
    if (urlOwner && urlRepo) {
      if (urlOwner.toLowerCase() === normalizedOwner && urlRepo.toLowerCase() === normalizedRepo) {
        return true;
      }
      continue;
    }

    const explicitOwner = match[4];
    const explicitRepo = match[5];
    if (
      explicitOwner &&
      explicitRepo &&
      explicitOwner.toLowerCase() === normalizedOwner &&
      explicitRepo.toLowerCase() === normalizedRepo
    ) {
      return true;
    }
  }

  return false;
}
