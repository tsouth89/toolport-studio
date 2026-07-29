/**
 * Single header overflow for IDE/scripts/git chrome so the chat title stays
 * primary. Agent loop chrome (Working / This turn) lives in the timeline.
 */
import { scopeThreadRef } from "@toolport-studio/client-runtime/environment";
import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@toolport-studio/contracts";
import { MoreHorizontalIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import type { DraftId } from "~/composerDraftStore";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { shouldShowOpenInPicker } from "./ChatHeader.logic";
import { OpenInPicker } from "./OpenInPicker";

/**
 * Label and controls share a line. Stacking them left/right put the label in one
 * corner and a single icon button in the other, which read as an empty menu.
 */
function ToolRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 px-1.5 py-1.5">
      <p className="shrink-0 text-[10.5px] font-medium tracking-wide text-muted-foreground/80 uppercase">
        {label}
      </p>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5">
        {children}
      </div>
    </div>
  );
}

export const ChatHeaderProjectTools = memo(function ChatHeaderProjectTools({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeProjectName,
  activeProjectCwd,
  isProjectless,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  gitCwd,
  primaryEnvironmentId,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  isProjectless: boolean;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  gitCwd: string | null;
  primaryEnvironmentId: EnvironmentId | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}) {
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const showScripts = !isProjectless && activeProjectScripts !== undefined;
  const showOpenIn = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const showGit = Boolean(activeProjectName);
  if (!showScripts && !showOpenIn && !showGit) {
    return null;
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="no-drag text-muted-foreground hover:text-foreground"
                  aria-label="Project tools"
                />
              }
            />
          }
        >
          <MoreHorizontalIcon className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Project tools</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-[min(15.5rem,calc(100vw-1.5rem))]"
        viewportClassName="divide-y divide-border/50 p-1 [--viewport-inline-padding:0px]"
      >
        {showScripts ? (
          <ToolRow label="Actions">
            <ProjectScriptsControl
              scripts={activeProjectScripts ?? []}
              fileScripts={fileScripts}
              keybindings={keybindings}
              preferredScriptId={preferredScriptId}
              onRunScript={onRunProjectScript}
              onAddScript={onAddProjectScript}
              onUpdateScript={onUpdateProjectScript}
              onDeleteScript={onDeleteProjectScript}
            />
          </ToolRow>
        ) : null}

        {showOpenIn ? (
          <ToolRow label="Open in">
            <OpenInPicker
              environmentId={activeThreadEnvironmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={openInCwd}
              compact
            />
          </ToolRow>
        ) : null}

        {showGit ? (
          <ToolRow label="Git">
            <GitActionsControl
              gitCwd={gitCwd}
              activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
              {...(draftId ? { draftId } : {})}
            />
          </ToolRow>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});
