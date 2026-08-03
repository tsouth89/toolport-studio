/**
 * Where a projectless session runs.
 *
 * A thread with no `projectId` still needs a concrete directory for filesystem
 * tools, but inventing a Project row for it is exactly what the null-workspace
 * model removes. So projectless sessions run in a dedicated scratch directory
 * that no Project points at.
 *
 * This is deliberately the same path the old "General" project used, so chats
 * migrated off that project keep reading and writing the files they already
 * had. Two directories were rejected on purpose:
 *
 * - the home directory, which would hand a full-access agent every repo, dotfile
 *   and key the user owns
 * - the server's own working directory, which is incidental (wherever the
 *   process was launched) and differs between providers that default to it
 *
 * @module projectlessWorkspace
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Unexpanded form, matching how project workspace roots are stored. */
export const PROJECTLESS_WORKSPACE_ROOT = "~/Toolport Studio/General";

/** Absolute scratch directory for sessions with no workspace attached. */
export function projectlessWorkspaceRoot(): string {
  return NodePath.join(NodeOS.homedir(), "Toolport Studio", "General");
}
