import { scopeThreadRef } from "@toolport-studio/client-runtime/environment";
import { Loader2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  countRunningBackgroundTasks,
  formatRunningBackgroundTaskLabel,
} from "../../backgroundTasks";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * App-level "N running tasks" chip.
 *
 * Reads the shell projection rather than thread activities so background work
 * in threads the client has never opened still counts — that is the whole point
 * of a global indicator. Clicking jumps to the thread with the most in-flight
 * tasks and opens the Agents panel there, so the work the chip is counting is
 * visible on arrival rather than leaving you on a thread that looks idle.
 */
export function SidebarBackgroundTasksPill() {
  const navigate = useNavigate();
  const threads = useThreadShells();

  const runningCount = useMemo(() => countRunningBackgroundTasks(threads), [threads]);
  const busiestThread = useMemo(() => {
    let best: (typeof threads)[number] | null = null;
    for (const thread of threads) {
      const count = thread.runningBackgroundTaskCount ?? 0;
      if (count === 0) continue;
      if (!best || count > (best.runningBackgroundTaskCount ?? 0)) {
        best = thread;
      }
    }
    return best;
  }, [threads]);

  const threadCount = useMemo(
    () => threads.filter((thread) => (thread.runningBackgroundTaskCount ?? 0) > 0).length,
    [threads],
  );

  const handleClick = useCallback(() => {
    if (!busiestThread) return;
    const threadRef = scopeThreadRef(busiestThread.environmentId, busiestThread.id);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
    // Navigating alone drops you on a thread whose turn has usually settled, so
    // it reads as idle and the chip looks like it lied. Open the roster the chip
    // is counting from, so the running work is on screen when you land.
    useRightPanelStore.getState().openAgents(threadRef);
  }, [busiestThread, navigate]);

  if (runningCount === 0) return null;

  const label = formatRunningBackgroundTaskLabel(runningCount);
  const tooltip =
    threadCount > 1
      ? `${label} across ${threadCount} threads — open the busiest`
      : `${label} in ${busiestThread?.title ?? "a thread"}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={tooltip}
            data-testid="sidebar-background-tasks-pill"
            className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg bg-primary/15 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/22"
            onClick={handleClick}
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
            <span className="truncate">{label}</span>
          </button>
        }
      />
      <TooltipPopup align="start" side="top">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}
