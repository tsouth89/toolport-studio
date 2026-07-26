/**
 * System "General" chat workspace — conversation without an explicit repo.
 * Backend still needs a project + cwd; we use a dedicated folder under home.
 * Product surface treats this as "no project selected" (SOU-357).
 */

export const GENERAL_CHAT_TITLE = "General";

/** Expanded by the server via WorkspacePaths (~ → homedir). */
export const GENERAL_CHAT_WORKSPACE_ROOT = "~/Toolport Studio/General";

export function isGeneralChatProject(project: {
  readonly title: string;
  readonly workspaceRoot: string;
}): boolean {
  const normalized = project.workspaceRoot.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.endsWith("/toolport studio/general") ||
    normalized.endsWith("/toolport-studio/general")
  );
}
