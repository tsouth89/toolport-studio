import type { ScopedProjectRef } from "@toolport-studio/contracts";
import { scopedProjectKey, scopeProjectRef } from "@toolport-studio/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@toolport-studio/client-runtime/state/runtime";
import { useParams } from "@tanstack/react-router";
import { FolderPlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useClientSettings } from "~/hooks/useSettings";
import { attachSessionToProject } from "~/lib/attachSessionToProject";
import { isGeneralChatProject } from "~/lib/generalChat";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "~/sidebarProjectGrouping";
import { useProjects, useThread, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import { toastManager } from "../ui/toast";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

interface DraftHeroHeadlineProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
  readonly isProjectless: boolean;
}

export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
  isProjectless,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const visibleProjects = useMemo(
    () => projects.filter((project) => !isGeneralChatProject(project)),
    [projects],
  );
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const handleNewThread = useNewThreadHandler();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useThread(routeThreadRef);
  const activeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const activeDraftThread = useComposerDraftStore((store) =>
    activeDraftId ? store.getDraftSession(activeDraftId) : null,
  );
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  const attachCurrentSessionToProject = useCallback(
    async (project: {
      environmentId: ScopedProjectRef["environmentId"];
      id: ScopedProjectRef["projectId"];
    }) => {
      const result = await attachSessionToProject({
        project,
        activeThread: activeThread
          ? { environmentId: activeThread.environmentId, id: activeThread.id }
          : null,
        activeDraftId,
        activeDraftThread,
        projects,
        projectGroupingSettings,
        updateServerThreadProject: async ({ environmentId, threadId, projectId }) => {
          const commandResult = await updateThreadMetadata({
            environmentId,
            input: {
              threadId,
              projectId,
              branch: null,
              worktreePath: null,
            },
          });
          if (commandResult._tag === "Failure") {
            if (isAtomCommandInterrupted(commandResult)) {
              return { ok: false, interrupted: true };
            }
            const error = squashAtomCommandFailure(commandResult);
            return {
              ok: false,
              message: error instanceof Error ? error.message : "An error occurred.",
            };
          }
          return { ok: true };
        },
      });
      if (!result.ok && result.description !== "Attachment was interrupted.") {
        toastManager.add({
          type: "error",
          title: result.title,
          description: result.description,
        });
      }
      return result.ok;
    },
    [
      activeDraftId,
      activeDraftThread,
      activeThread,
      projectGroupingSettings,
      projects,
      updateThreadMetadata,
    ],
  );

  // Projectless "What's on your mind?" must attach the *current* draft so typed
  // text and attachments travel with the folder. Opening a brand-new project
  // draft via handleNewThread is what used to wipe the composer.
  const openAttachOrAddProject = useCallback(() => {
    openCommandPalette({ open: isProjectless ? "attach-project" : "add-project" });
  }, [isProjectless]);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects: visibleProjects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        // Match sidebar shelves: stable order, not activity auto-sort.
        projectSortOrder === "manual" ? "manual" : projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      visibleProjects,
      threads,
    ],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = isProjectless
    ? null
    : (activeProjectGroup?.displayName ?? activeProjectTitle);
  const hasResolvedProject = activeProjectTitle !== null && !isProjectless;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <MenuTrigger
        aria-label={hasResolvedProject ? "Change project" : "Choose a project"}
        className="pointer-events-auto inline cursor-pointer border-current border-b border-dotted text-foreground underline-offset-8 transition-opacity hover:opacity-75 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {activeProjectDisplayName ?? "Attach a folder"}
      </MenuTrigger>
      <MenuPopup align="center" className="max-h-80 w-64 overflow-y-auto">
        <MenuRadioGroup
          value={activeProjectKey}
          onValueChange={(value) => {
            const entry = projectEntryByKey.get(value as string);
            if (!entry || value === activeProjectKey) {
              return;
            }
            const project = entry.targetProject;
            if (isProjectless) {
              void attachCurrentSessionToProject({
                environmentId: project.environmentId,
                id: project.id,
              });
              return;
            }
            void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
              replace: true,
            });
          }}
        >
          {projectPickerEntries.map(({ group }) => {
            return (
              <MenuRadioItem key={group.projectKey} value={group.projectKey} closeOnClick>
                <span className="min-w-0 truncate">{group.displayName}</span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={openAttachOrAddProject}>
          <FolderPlusIcon />
          {isProjectless ? "Choose another folder…" : "New project"}
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAttachOrAddProject}
      className="pointer-events-auto inline cursor-pointer border-current border-b border-dotted text-muted-foreground/60 underline-offset-8 transition-opacity hover:opacity-75 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {isProjectless ? "Attach a folder" : (activeProjectTitle ?? "Add a project")}
    </button>
  );

  return (
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {isProjectless ? (
        <>
          What&apos;s on your mind?
          <span className="mt-3 block text-base text-muted-foreground">{projectSelector}</span>
        </>
      ) : hasResolvedProject ? (
        <>What should we build in {projectSelector}?</>
      ) : canChooseProject ? (
        <>{projectSelector} to start</>
      ) : (
        <>Add a project to start</>
      )}
    </h1>
  );
}
