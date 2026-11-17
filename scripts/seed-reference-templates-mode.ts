export const CONTENT_HANDOFF_SLUGS = [
  'song-hy-v2-do',
  'to-duyen-do-dam',
  'minimalism-nau-dam',
  'cam-thach-vang',
  'to-duyen-xanh',
] as const;

export type ContentHandoffSlug = typeof CONTENT_HANDOFF_SLUGS[number];

export type ReferenceSeedArgs =
  | { mode: 'published'; slug?: string }
  | { mode: 'content-handoff'; slug: ContentHandoffSlug; dryRun: boolean };

export function parseReferenceSeedArgs(args: string[]): ReferenceSeedArgs {
  const slugs = args.filter((arg) => arg.startsWith('--slug=')).map((arg) => arg.slice('--slug='.length));
  const statuses = args.filter((arg) => arg.startsWith('--status=')).map((arg) => arg.slice('--status='.length));
  const dryRuns = args.filter((arg) => arg === '--dry-run');
  const knownArgs = new Set([...slugs.map((slug) => `--slug=${slug}`), ...statuses.map((status) => `--status=${status}`), ...dryRuns]);
  const unknown = args.filter((arg) => !knownArgs.has(arg));

  if (unknown.length) throw new Error(`Unknown reference seed argument: ${unknown.join(', ')}`);
  if (slugs.length > 1 || statuses.length > 1 || dryRuns.length > 1) throw new Error('Reference seed flags may only be supplied once.');
  if (statuses.some((status) => status !== 'UNLISTED')) throw new Error('Only --status=UNLISTED is supported for content handoffs.');

  const slug = slugs[0];
  if (statuses.length || dryRuns.length) {
    if (!statuses.length) throw new Error('--dry-run requires --status=UNLISTED.');
    if (!slug) throw new Error('Content handoff mode requires exactly one --slug.');
    if (!CONTENT_HANDOFF_SLUGS.includes(slug as ContentHandoffSlug)) throw new Error(`${slug} is not in the content handoff queue.`);
    return { mode: 'content-handoff', slug: slug as ContentHandoffSlug, dryRun: dryRuns.length === 1 };
  }

  if (slug === '') throw new Error('--slug must not be empty.');
  return { mode: 'published', ...(slug ? { slug } : {}) };
}

export function selectContentHandoff(
  templates: Array<{ id: string; status: string; tags: string[] }>,
  slug: string,
): string | null {
  const matches = templates.filter((template) =>
    template.status === 'UNLISTED' && template.tags.includes(slug) && template.tags.includes('clone-content-draft'),
  );
  if (matches.length > 1) throw new Error(`Multiple content handoffs exist for ${slug}; refusing to choose or delete one.`);
  return matches[0]?.id ?? null;
}

export function filterPublishedSeedTargets<T extends { tags: string[] }>(templates: T[]): T[] {
  return templates.filter((template) => !template.tags.includes('clone-content-draft'));
}

export function findMissingCatalogAssets(sources: string[], catalogUrls: string[]): string[] {
  const catalog = new Set(catalogUrls);
  return [...new Set(sources.filter((source) => source && !catalog.has(source)))];
}
