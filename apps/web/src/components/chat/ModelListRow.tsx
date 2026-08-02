import { type ProviderDriverKind, type ProviderInstanceId } from "@toolport-studio/contracts";
import { memo } from "react";
import { StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
} from "./providerIconUtils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  presetId?: string | undefined;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  sectionLabel?: string | undefined;
  sectionHint?: string | undefined;
  sectionSeparated?: boolean | undefined;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: () => void;
}) {
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={`${props.instanceId}:${props.model.slug}`}
      disabled={Boolean(props.disabledReason)}
      contentClassName="flex w-full items-center gap-3"
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer rounded-md px-2 py-2.5 transition-[background-color,box-shadow,color]",
        "hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] data-highlighted:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] data-selected:bg-foreground/[0.08] data-selected:text-foreground data-selected:ring-0 [&[data-highlighted][data-selected]]:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))]",
        // The current model was distinguishable only by a faint background, so
        // it read the same as a hovered row. Give it an edge marker instead.
        "data-selected:before:absolute data-selected:before:left-0 data-selected:before:top-1/2 data-selected:before:h-4 data-selected:before:w-0.5 data-selected:before:-translate-y-1/2 data-selected:before:rounded-r-full data-selected:before:bg-primary",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed data-disabled:hover:bg-transparent",
      )}
    >
      <ProviderInstanceIcon
        driverKind={props.driverKind}
        presetId={props.presetId}
        displayName={props.providerDisplayName}
        accentColor={props.providerAccentColor}
        showBadge={props.showProvider && Boolean(props.providerAccentColor)}
        className="size-7"
        iconClassName="size-5"
        badgeClassName="h-3 min-w-3 px-0.5 text-[7px]"
        indicatorBackground="var(--popover)"
      />
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate text-xs font-medium leading-snug">
            {props.useTriggerLabel
              ? getTriggerDisplayModelLabel(props.model)
              : getDisplayModelName(
                  props.model,
                  props.preferShortName ? { preferShortName: true } : undefined,
                )}
          </div>
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded border border-amber-500/35 bg-amber-500/15 px-0.5 py-px text-[10px] font-bold uppercase leading-none tracking-wide text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/12 dark:text-amber-200"
              aria-label="New model"
            >
              New
            </span>
          ) : null}
        </div>
        {props.showProvider && (
          <div className="mt-1 flex items-center gap-1.5">
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
              {providerLabel}
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.isSelected ? (
          <span className="rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium leading-none text-primary">
            Selected
          </span>
        ) : null}
        {props.jumpLabel ? (
          // Held back until the row is in play. These sat at full strength on
          // every row, competing with the favourite stars along the same edge
          // and making the list look busier than it is.
          <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px] opacity-0 transition-opacity group-hover:opacity-100 group-data-highlighted:opacity-100 group-data-selected:opacity-100">
            {props.jumpLabel}
          </Kbd>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className={cn(
                  "-mr-1 shrink-0 text-muted-foreground/70 opacity-64 transition-[color,opacity] hover:text-foreground hover:opacity-100 group-hover:opacity-100",
                  props.isFavorite && "text-foreground opacity-100",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                disabled={Boolean(props.disabledReason)}
                aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-yellow-500",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </ComboboxItem>
  );

  const rowWithDisabledReason = props.disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center" className="max-w-64 text-balance leading-snug">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  ) : (
    row
  );

  if (!props.sectionLabel) return rowWithDisabledReason;

  return (
    <div className={cn(props.sectionSeparated && "mt-2 border-t border-border/55 pt-2")}>
      <div className="flex items-center gap-2 px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
        <span>{props.sectionLabel}</span>
        {props.sectionHint ? (
          <span className="font-normal normal-case tracking-normal text-muted-foreground/50">
            {props.sectionHint}
          </span>
        ) : null}
      </div>
      {rowWithDisabledReason}
    </div>
  );
});
