/**
 * Library search across a chosen set of projects. Kept pure so the Books UI
 * can search one project, a hand-picked subset, or the whole library without
 * the store action being the only covered path.
 */

export interface SearchableFile {
  id: string;
  name: string;
  tags: string[];
  notes: string;
}

export interface SearchableProject {
  id: string;
  fileIds: string[];
}

export interface SearchableFolder {
  projectId: string;
  fileIds: string[];
}

/**
 * Filter `files` by a case-insensitive match on name, tags or notes.
 *
 * `projectIds` controls the scope:
 * - `null` — every project in the library
 * - a single id — just that project (files at its root or in any of its folders)
 * - an array of ids — the union of those projects; an empty array matches nothing
 */
export function searchLibrary<F extends SearchableFile>(
  files: F[],
  projects: SearchableProject[],
  folders: SearchableFolder[],
  query: string,
  projectIds: string | string[] | null,
): F[] {
  const lower = query.toLowerCase();
  const belongsToScope = (fileId: string): boolean => {
    if (projectIds === null) return true;
    const inProject = (project: SearchableProject): boolean =>
      project.fileIds.includes(fileId) ||
      folders.some((folder) => folder.projectId === project.id && folder.fileIds.includes(fileId));
    if (Array.isArray(projectIds)) {
      if (projectIds.length === 0) return false;
      const wanted = new Set(projectIds);
      return projects.some((project) => wanted.has(project.id) && inProject(project));
    }
    const project = projects.find((p) => p.id === projectIds);
    return project ? inProject(project) : false;
  };

  return files
    .filter((file) => {
      const matchesQuery =
        file.name.toLowerCase().includes(lower) ||
        file.tags.some((tag) => tag.toLowerCase().includes(lower)) ||
        file.notes.toLowerCase().includes(lower);
      return matchesQuery && belongsToScope(file.id);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
