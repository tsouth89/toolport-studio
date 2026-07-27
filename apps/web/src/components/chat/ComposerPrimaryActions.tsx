import { memo, type PointerEventHandler } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ListPlusIcon, ZapIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  /** Inject composer content into the live turn (steer / interject). */
  onSteer?: () => void;
  /** Queue for after the live turn finishes (default while running). */
  onQueue?: () => void;
  onImplementPlanInNewThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

const StopCircleButton = memo(function StopCircleButton({
  onClick,
  pointerFocusProps,
  ariaLabel,
}: {
  onClick: () => void;
  pointerFocusProps?: { onPointerDown: PointerEventHandler<HTMLElement> };
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-destructive/25 bg-destructive/10 text-destructive transition-colors duration-150 hover:border-destructive/40 hover:bg-destructive/15 active:bg-destructive/20 sm:size-8"
      {...pointerFocusProps}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2.5" y="2.5" width="7" height="7" rx="1.25" />
      </svg>
    </button>
  );
});

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  onPreviousPendingQuestion,
  onInterrupt,
  onSteer,
  onQueue,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const stageBackdropVariant = useSidebarStageBackdropVariant();

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </Button>
      </div>
    );
  }

  // Stuck local "Sending" (pre-running): cancel only — no provider turn yet.
  if (isSendBusy && !isRunning) {
    return (
      <StopCircleButton
        onClick={onInterrupt}
        {...(pointerFocusProps ? { pointerFocusProps } : {})}
        ariaLabel="Cancel sending"
      />
    );
  }

  // Live turn: primary Queue (Enter), secondary Send now (steer), Stop.
  if (isRunning) {
    const canQueueOrSteer = !isEnvironmentUnavailable && hasSendableContent;
    return (
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors",
            "hover:bg-muted/80 hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-35",
          )}
          {...pointerFocusProps}
          disabled={!canQueueOrSteer || !onSteer}
          aria-label="Send into live turn now"
          title="Send now (Ctrl+Enter) — inject into the live turn"
          onClick={() => onSteer?.()}
        >
          <ZapIcon className="size-3.5 shrink-0 opacity-80" aria-hidden="true" />
          <span className="hidden sm:inline">Send now</span>
        </button>
        <button
          type="button"
          className={cn(
            "relative isolate inline-flex h-8 items-center gap-1.5 overflow-hidden rounded-full px-3 text-xs font-semibold text-primary-foreground transition-all duration-150",
            "enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-[1.02] active:scale-[0.98]",
            "disabled:pointer-events-none disabled:opacity-35",
            stageBackdropVariant
              ? "bg-transparent enabled:shadow-xs enabled:shadow-black/20 enabled:hover:brightness-110"
              : "bg-primary/90 enabled:shadow-xs enabled:shadow-primary/20 hover:bg-primary",
          )}
          {...pointerFocusProps}
          disabled={!canQueueOrSteer || !onQueue}
          aria-label="Queue message for after this turn"
          title="Queue (Enter) — runs after this turn finishes"
          onClick={() => onQueue?.()}
        >
          <span className="absolute inset-0 -z-10" aria-hidden="true">
            <StageBackdropButtonArt variant={stageBackdropVariant} />
          </span>
          <ListPlusIcon className="size-3.5 shrink-0" aria-hidden="true" />
          Queue
        </button>
        <StopCircleButton
          onClick={onInterrupt}
          {...(pointerFocusProps ? { pointerFocusProps } : {})}
          ariaLabel="Stop generation"
        />
      </div>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
          {...pointerFocusProps}
          disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
          {...pointerFocusProps}
          disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                aria-label="Implementation actions"
                {...pointerFocusProps}
                disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  return (
    <button
      type="submit"
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full text-primary-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8",
        stageBackdropVariant
          ? "bg-transparent enabled:shadow-black/24 enabled:hover:brightness-110"
          : "bg-primary/90 enabled:shadow-primary/24 hover:bg-primary",
      )}
      {...pointerFocusProps}
      disabled={isSendBusy || isConnecting || isEnvironmentUnavailable || !hasSendableContent}
      aria-label={
        isEnvironmentUnavailable
          ? "Environment disconnected"
          : isConnecting
            ? "Connecting"
            : isPreparingWorktree
              ? "Preparing worktree"
              : isSendBusy
                ? "Sending"
                : "Send message"
      }
    >
      <span className="absolute inset-0 -z-10" aria-hidden="true">
        <StageBackdropButtonArt variant={stageBackdropVariant} />
      </span>
      {isConnecting || isSendBusy ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
});
