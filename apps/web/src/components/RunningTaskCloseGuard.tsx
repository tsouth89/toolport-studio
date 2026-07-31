import type { EnvironmentThreadShell } from "@toolport-studio/client-runtime/state/shell";
import { useEffect, useMemo } from "react";

import { deriveComposerPhase } from "../session-logic";
import { useThreadShells } from "../state/entities";

type CloseGuardThread = Pick<EnvironmentThreadShell, "latestTurn" | "session">;

export function hasRunningTask(threads: ReadonlyArray<CloseGuardThread>): boolean {
  return threads.some((thread) => {
    const phase = deriveComposerPhase(thread.session, thread.latestTurn);
    return phase === "connecting" || phase === "running";
  });
}

export function RunningTaskCloseGuard() {
  const threads = useThreadShells();
  const closeConfirmationRequired = useMemo(() => hasRunningTask(threads), [threads]);

  useEffect(() => {
    const setCloseConfirmationRequired = window.desktopBridge?.setCloseConfirmationRequired;
    if (!setCloseConfirmationRequired) {
      return;
    }
    void setCloseConfirmationRequired(closeConfirmationRequired).catch(() => undefined);
  }, [closeConfirmationRequired]);

  useEffect(
    () => () => {
      void window.desktopBridge?.setCloseConfirmationRequired?.(false).catch(() => undefined);
    },
    [],
  );

  return null;
}
