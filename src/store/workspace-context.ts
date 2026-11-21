/** The active workspace id, mirrored from the canvas store without a circular import. */
let currentWorkspaceId = 'default';

export function currentWorkspace(): string {
  return currentWorkspaceId;
}

export function setCurrentWorkspace(id: string): void {
  currentWorkspaceId = id;
}
