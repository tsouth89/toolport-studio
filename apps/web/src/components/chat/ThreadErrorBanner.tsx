import { memo } from "react";
import { extractProviderErrorMessage } from "@t3tools/shared/providerError";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  onRetry,
}: {
  error: string | null;
  onDismiss?: () => void;
  /** One-tap resend of the last user message (SOU-363 auto-stop recovery). */
  onRetry?: () => void;
}) {
  if (!error) return null;
  // Errors persisted before the server started unwrapping provider payloads
  // can still be raw JSON, so unwrap here too.
  const message = extractProviderErrorMessage(error);
  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3 break-words" />}>
              {message}
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap break-words">
              {message}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {(onRetry || onDismiss) && (
          <AlertAction>
            <div className="flex items-center gap-1">
              {onRetry ? (
                <Button
                  variant="outline"
                  size="xs"
                  className="border-destructive/30 bg-background/60 text-destructive hover:bg-destructive/10"
                  onClick={onRetry}
                  aria-label="Retry last message"
                >
                  Retry
                </Button>
              ) : null}
              {onDismiss ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Dismiss error"
                  onClick={onDismiss}
                >
                  <XIcon className="text-destructive" />
                </Button>
              ) : null}
            </div>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
