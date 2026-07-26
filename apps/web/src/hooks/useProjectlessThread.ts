import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useCallback, useMemo, useRef } from "react";

import {
  GENERAL_CHAT_TITLE,
  GENERAL_CHAT_WORKSPACE_ROOT,
  isGeneralChatProject,
} from "~/lib/generalChat";
import { newProjectId } from "~/lib/utils";
import { resolveDefaultProviderModelSelection } from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { primaryServerProvidersAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

export function useProjectlessThreadHandler() {
  const projects = useProjects();
  const existingGeneralProject = useMemo(
    () => projects.find((project) => isGeneralChatProject(project)) ?? null,
    [projects],
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();
  const pendingStartRef = useRef<Promise<boolean> | null>(null);

  return useCallback((): Promise<boolean> => {
    if (pendingStartRef.current) {
      return pendingStartRef.current;
    }

    const pendingStart = (async () => {
      const environmentId =
        existingGeneralProject?.environmentId ??
        primaryEnvironmentId ??
        environments[0]?.environmentId ??
        null;
      if (environmentId === null) {
        return false;
      }

      let projectId = existingGeneralProject?.id;
      if (projectId === undefined) {
        projectId = newProjectId();
        const environmentProviders =
          environments.find((environment) => environment.environmentId === environmentId)
            ?.serverConfig?.providers ?? primaryProviders;
        const createResult = await createProject({
          environmentId,
          input: {
            projectId,
            title: GENERAL_CHAT_TITLE,
            workspaceRoot: GENERAL_CHAT_WORKSPACE_ROOT,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: resolveDefaultProviderModelSelection(environmentProviders, null),
          },
        });
        if (createResult._tag === "Failure") {
          if (isAtomCommandInterrupted(createResult)) {
            return false;
          }
          throw squashAtomCommandFailure(createResult);
        }
      }

      await handleNewThread(scopeProjectRef(environmentId, projectId), {
        envMode: "local",
      });
      return true;
    })();

    pendingStartRef.current = pendingStart;
    const clearPendingStart = () => {
      if (pendingStartRef.current === pendingStart) pendingStartRef.current = null;
    };
    void pendingStart.then(clearPendingStart, clearPendingStart);
    return pendingStart;
  }, [
    createProject,
    environments,
    existingGeneralProject,
    handleNewThread,
    primaryEnvironmentId,
    primaryProviders,
  ]);
}
