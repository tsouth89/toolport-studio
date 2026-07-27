import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

function approvalHeadline(requestKind: PendingApproval["requestKind"]): string {
  switch (requestKind) {
    case "command":
      return "Allow this command?";
    case "file-read":
      return "Allow reading this file?";
    case "file-change":
      return "Allow this file change?";
  }
}

function detailLabel(requestKind: PendingApproval["requestKind"]): string {
  switch (requestKind) {
    case "command":
      return "Command";
    case "file-read":
      return "File";
    case "file-change":
      return "Change";
  }
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-foreground">
          {approvalHeadline(approval.requestKind)}
        </span>
        {pendingCount > 1 ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
            1 of {pendingCount}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        The agent is waiting. Approve to continue, or deny. Unanswered requests cancel after a few
        minutes.
      </p>
      {approval.detail ? (
        <div className="mt-3 rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            {detailLabel(approval.requestKind)}
          </p>
          <pre
            aria-label={detailLabel(approval.requestKind)}
            className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground"
            data-approval-detail="complete"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
