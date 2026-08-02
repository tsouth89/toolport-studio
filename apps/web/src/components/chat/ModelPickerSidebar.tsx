import { type CSSProperties, memo, type ReactNode, useMemo } from "react";
import { type ProviderInstanceId } from "@toolport-studio/contracts";
import { LockIcon, SettingsIcon, SparklesIcon } from "lucide-react";

import { ProviderInstanceIcon, providerInstanceInitials } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";

function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  if (!entry.enabled || entry.status === "disabled") {
    return `${label} — Disabled in settings.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const kind =
    entry.status === "error" ? "Unavailable" : entry.status === "warning" ? "Limited" : "Not ready";
  const message = entry.snapshot.message?.trim();
  return message ? `${label} — ${kind}. ${message}` : `${label} — ${kind}.`;
}

function statusDotClassName(entry: ProviderInstanceEntry): string {
  if (isProviderInstancePickerReady(entry)) return "bg-emerald-500";
  if (entry.status === "warning") return "bg-amber-500";
  return "bg-muted-foreground/55";
}

const NAV_ITEM_CLASS =
  "relative flex min-h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "recommended";
  onSelectInstance: (instanceId: ProviderInstanceId | "recommended") => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showRecommended?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
  onManageProviders?: () => void;
}) {
  const showRecommended = props.showRecommended ?? true;
  const duplicateDriverCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of props.instanceEntries) {
      counts.set(entry.driverKind, (counts.get(entry.driverKind) ?? 0) + 1);
    }
    return counts;
  }, [props.instanceEntries]);

  const smartView = (id: "recommended", label: string, icon: ReactNode) => {
    const isSelected = props.selectedInstanceId === id;
    return (
      <button
        type="button"
        className={cn(
          NAV_ITEM_CLASS,
          "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
          isSelected &&
            "bg-foreground/[0.08] text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-r-full before:bg-primary",
        )}
        onClick={() => props.onSelectInstance(id)}
        data-model-picker-provider={id}
        aria-current={isSelected ? "page" : undefined}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      </button>
    );
  };

  return (
    <aside
      className="flex w-52 shrink-0 flex-col border-r border-border/65 bg-muted/25"
      data-model-picker-sidebar="true"
      aria-label="Model picker navigation"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-3">
        {showRecommended ? (
          <section>
            <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/65">
              Views
            </div>
            <div className="space-y-0.5">
              {showRecommended
                ? smartView(
                    "recommended",
                    "For you",
                    <SparklesIcon className="size-4" aria-hidden />,
                  )
                : null}
            </div>
          </section>
        ) : null}

        <section className={cn(showRecommended && "mt-5")}>
          <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/65">
            Accounts
          </div>
          <div className="space-y-0.5">
            {props.instanceEntries.map((entry) => {
              const isUnavailable = !isProviderInstancePickerReady(entry);
              const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
              const isDisabled = isUnavailable || isContextDisabled;
              const isSelected = props.selectedInstanceId === entry.instanceId;
              const showAccountBadge =
                Boolean(entry.accentColor) ||
                (duplicateDriverCounts.get(entry.driverKind) ?? 0) > 1;
              const tooltip = isUnavailable
                ? describeUnavailableInstance(entry)
                : isContextDisabled
                  ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
                  : entry.displayName;
              const accentStyle = entry.accentColor
                ? ({ borderColor: entry.accentColor, color: entry.accentColor } as CSSProperties)
                : undefined;

              const button = (
                <button
                  key={entry.instanceId}
                  type="button"
                  className={cn(
                    NAV_ITEM_CLASS,
                    "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
                    isSelected &&
                      !isDisabled &&
                      "bg-foreground/[0.08] text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-r-full before:bg-primary",
                    isDisabled && "cursor-not-allowed opacity-45 hover:bg-transparent",
                  )}
                  onClick={() => !isDisabled && props.onSelectInstance(entry.instanceId)}
                  disabled={isDisabled}
                  data-model-picker-provider={entry.instanceId}
                  aria-label={isDisabled ? tooltip : entry.displayName}
                  aria-current={isSelected ? "page" : undefined}
                >
                  <ProviderInstanceIcon
                    driverKind={entry.driverKind}
                    presetId={entry.presetId}
                    displayName={entry.displayName}
                    accentColor={entry.accentColor}
                    className="size-5"
                    iconClassName="size-4.5"
                    statusDotClassName={statusDotClassName(entry)}
                    indicatorBackground="var(--popover)"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{entry.displayName}</span>
                  {isContextDisabled ? <LockIcon className="size-3" aria-hidden /> : null}
                  {!isContextDisabled && showAccountBadge ? (
                    <span
                      className="flex h-4 min-w-5 items-center justify-center rounded border border-border/80 px-1 text-[8px] font-semibold leading-none text-muted-foreground"
                      style={accentStyle}
                      aria-hidden
                    >
                      {providerInstanceInitials(entry.displayName)}
                    </span>
                  ) : null}
                </button>
              );

              if (!isDisabled) return button;
              return (
                <Tooltip key={entry.instanceId}>
                  <TooltipTrigger render={<span className="block">{button}</span>} />
                  <TooltipPopup side="right" align="center" className="max-w-72 text-balance">
                    {tooltip}
                  </TooltipPopup>
                </Tooltip>
              );
            })}
          </div>
        </section>
      </div>

      {props.onManageProviders ? (
        <div className="border-t border-border/55 p-2">
          <button
            type="button"
            className={cn(
              NAV_ITEM_CLASS,
              "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
            )}
            onClick={props.onManageProviders}
          >
            <SettingsIcon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">Manage providers</span>
          </button>
        </div>
      ) : null}
    </aside>
  );
});
