import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@toolport-studio/contracts";
import { memo } from "react";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { ProjectFavicon } from "../ProjectFavicon";
import { cn } from "~/lib/utils";
import { FolderPlusIcon } from "lucide-react";
import { ChatHeaderProjectTools } from "./ChatHeaderProjectTools";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  isProjectless: boolean;
  canAttachProject: boolean;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  onAttachProject: () => void;
}

/** @deprecated Import from `./ChatHeader.logic` — re-exported for existing call sites. */
export { shouldShowOpenInPicker } from "./ChatHeader.logic";

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  activeProjectCwd,
  isProjectless,
  canAttachProject,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onAttachProject,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:gap-2.5">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <ProjectFavicon
                environmentId={activeThreadEnvironmentId}
                cwd={activeProjectCwd ?? ""}
                className="size-3.5"
              />
              <span className="max-w-40 truncate text-[13px] font-medium text-muted-foreground">
                {activeProjectName}
              </span>
            </span>
            <span aria-hidden className="text-muted-foreground/35">
              /
            </span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
      <div
        data-chat-header-actions
        className={cn(
          // Sparse chrome: title first; IDE/scripts/git live under one overflow.
          "flex shrink-0 items-center justify-end gap-1",
          rightPanelOpen ? "pr-0" : "pr-14",
        )}
      >
        {isProjectless ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onAttachProject}
                  disabled={!canAttachProject}
                  className="no-drag inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FolderPlusIcon className="size-3.5" />
                  <span className="hidden @3xl/header-actions:inline">Attach folder</span>
                </button>
              }
            />
            <TooltipPopup side="bottom">
              {canAttachProject
                ? "Attach this conversation to a folder"
                : "Wait for the current response to finish"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <ChatHeaderProjectTools
          activeThreadEnvironmentId={activeThreadEnvironmentId}
          activeThreadId={activeThreadId}
          {...(draftId ? { draftId } : {})}
          activeProjectName={activeProjectName}
          activeProjectCwd={activeProjectCwd}
          isProjectless={isProjectless}
          openInCwd={openInCwd}
          activeProjectScripts={activeProjectScripts}
          preferredScriptId={preferredScriptId}
          keybindings={keybindings}
          availableEditors={availableEditors}
          gitCwd={gitCwd}
          primaryEnvironmentId={primaryEnvironmentId}
          onRunProjectScript={onRunProjectScript}
          onAddProjectScript={onAddProjectScript}
          onUpdateProjectScript={onUpdateProjectScript}
          onDeleteProjectScript={onDeleteProjectScript}
        />
      </div>
    </div>
  );
});
