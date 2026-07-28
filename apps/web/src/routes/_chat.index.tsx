import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@toolport-studio/client-runtime/state/runtime";
import { scopeProjectRef } from "@toolport-studio/client-runtime/environment";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LinkIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { primaryServerProvidersAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import {
  GENERAL_CHAT_TITLE,
  GENERAL_CHAT_WORKSPACE_ROOT,
  isGeneralChatProject,
} from "~/lib/generalChat";
import { resolveDefaultProviderModelSelection } from "~/providerInstances";
import { cn, newProjectId } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments } = useEnvironments();

  if (authGateState.status === "hosted-static" && environments.length === 0) {
    return <HostedStaticOnboardingState />;
  }

  return <IndexDraftLanding />;
}

/**
 * Landing on the index route drops straight into a draft thread for the most
 * recently active project, so the first screen is a prompt instead of a dead
 * end. When no project exists yet, auto-create the system General chat
 * workspace (SOU-357) instead of forcing "Add project".
 */
function IndexDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject = useMemo(
    () =>
      bootstrapped
        ? (sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null)
        : null,
    [bootstrapped, projects, threads],
  );

  const existingGeneralProject = useMemo(
    () => projects.find((project) => isGeneralChatProject(project)) ?? null,
    [projects],
  );

  useEffect(() => {
    if (!bootstrapped || startingRef.current) {
      return;
    }

    if (mostRecentProject !== null) {
      startingRef.current = true;
      void handleNewThread(scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id), {
        replace: true,
      }).catch(() => {
        startingRef.current = false;
        setStartState((state) => ({ ...state, failed: true }));
      });
      return;
    }

    // No projects yet: open General chat (create if needed) so the home
    // screen is a composer, not an Add project wall.
    const environmentId =
      existingGeneralProject?.environmentId ??
      primaryEnvironmentId ??
      environments[0]?.environmentId ??
      null;
    if (environmentId === null) {
      return;
    }

    startingRef.current = true;
    void (async () => {
      try {
        let projectId = existingGeneralProject?.id;
        if (projectId === undefined) {
          projectId = newProjectId();
          const targetEnvironmentProviders =
            environments.find((environment) => environment.environmentId === environmentId)
              ?.serverConfig?.providers ?? providers;
          const createResult = await createProject({
            environmentId,
            input: {
              projectId,
              title: GENERAL_CHAT_TITLE,
              workspaceRoot: GENERAL_CHAT_WORKSPACE_ROOT,
              createWorkspaceRootIfMissing: true,
              defaultModelSelection: resolveDefaultProviderModelSelection(
                targetEnvironmentProviders,
                null,
              ),
            },
          });
          if (createResult._tag === "Failure") {
            if (!isAtomCommandInterrupted(createResult)) {
              startingRef.current = false;
              setStartState((state) => ({ ...state, failed: true }));
            }
            return;
          }
        }
        await handleNewThread(scopeProjectRef(environmentId, projectId), {
          replace: true,
          envMode: "local",
        });
      } catch {
        startingRef.current = false;
        setStartState((state) => ({ ...state, failed: true }));
      }
    })();
  }, [
    bootstrapped,
    createProject,
    environments,
    existingGeneralProject,
    handleNewThread,
    mostRecentProject,
    primaryEnvironmentId,
    providers,
    startState.retryRequest,
  ]);

  if (!bootstrapped) {
    return null;
  }
  if (mostRecentProject !== null || existingGeneralProject !== null || primaryEnvironmentId) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          startingRef.current = false;
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  return <NoProjectsHero />;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function NoProjectsHero() {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                What should we work on?
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Connect an environment, then start chatting. You can attach a folder anytime.
              </EmptyDescription>
              <div className="mt-6 flex justify-center gap-2">
                <Button render={<Link to="/settings/connections" />} size="sm" variant="outline">
                  Connections
                </Button>
                <Button size="sm" onClick={openAddProject}>
                  <PlusIcon className="size-4" />
                  Add project
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5 sm:py-3",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect an environment to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {cloudEnabled
                  ? "Sign in to Toolport Connect to connect a linked environment through its managed tunnel, or add a reachable backend manually."
                  : "Add a reachable backend manually to start working from this browser."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  {cloudEnabled ? "Open Connections" : "Add environment"}
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
