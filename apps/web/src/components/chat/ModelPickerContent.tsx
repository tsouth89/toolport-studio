import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@toolport-studio/contracts";
import { resolveSelectableModel } from "@toolport-studio/shared/model";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useNavigate } from "@tanstack/react-router";
import { memo, useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { SearchIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { isModelPickerNewModel } from "./modelPickerModelHighlights";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxListVirtualized } from "../ui/combobox";
import { ModelEsque } from "./providerIconUtils";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { TooltipProvider } from "../ui/tooltip";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import { selectRecommendedModels } from "../../modelRecommendations";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  /** BYOK preset id, so the row can show the provider's own logo. */
  presetId?: string | undefined;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  continuationGroupKey?: string | undefined;
  isCustom?: boolean | undefined;
  isDefault?: boolean | undefined;
};

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();

// Split a `${instanceId}:${slug}` combobox key back into its pieces. Slugs
// can contain colons (e.g. some vendor model ids), so we only split on the
// first colon — anything after that is the slug.
function splitInstanceModelKey(key: string): { instanceId: ProviderInstanceId; slug: string } {
  const colonIndex = key.indexOf(":");
  if (colonIndex === -1) {
    return { instanceId: key as ProviderInstanceId, slug: "" };
  }
  return {
    instanceId: key.slice(0, colonIndex) as ProviderInstanceId,
    slug: key.slice(colonIndex + 1),
  };
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  /** The instance currently selected in the composer (combobox "value"). */
  activeInstanceId: ProviderInstanceId;
  model: string;
  /**
   * When set, the picker is locked to the given driver kind — typically
   * because the user is editing a previously-sent message and can't change
   * which driver served the turn. Multiple instances of the same kind
   * remain selectable (e.g. locked to `codex` still lets the user switch
   * between the default Codex and a custom Codex Personal).
   */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /**
   * All configured provider instances in display order. Used to render
   * the sidebar (one button per instance) and to resolve display names
   * for the locked-mode header.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  /**
   * Model options per instance. Keyed by `ProviderInstanceId` so the
   * default Codex instance and any custom Codex instances each have their
   * own list (custom instances typically start with the same built-in
   * model set but are free to diverge via customModels).
   */
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const [forYouAccountFilter, setForYouAccountFilter] = useState<ProviderInstanceId | "all">("all");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<LegendListRef | null>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const favorites = useClientSettings((s) => s.favorites ?? []);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | "recommended">(
    () => {
      if (props.lockedProvider !== null) {
        // When locked, prime the sidebar to the currently-active instance
        // so jumping into the picker keeps the focused instance visible.
        return props.activeInstanceId;
      }
      return "recommended";
    },
  );
  const keybindings = useMemo<ResolvedKeybindingsConfig>(
    () => providedKeybindings ?? [],
    [providedKeybindings],
  );
  const updateSettings = useUpdateClientSettings();
  const navigate = useNavigate();

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSelectInstance = useCallback(
    (instanceId: ProviderInstanceId | "recommended") => {
      setSelectedInstanceId(instanceId);
      setSearchQuery("");
      if (instanceId === "recommended") {
        setForYouAccountFilter("all");
      }
      window.requestAnimationFrame(() => {
        focusSearchInput();
      });
    },
    [focusSearchInput],
  );

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  // Create a Set for efficient lookup. Favorites are keyed by
  // `${instanceId}:${slug}`; the storage schema widened from ProviderDriverKind
  // to ProviderInstanceId so pre-migration favorites keyed by driver slugs
  // (e.g. `"codex:gpt-5"`) still resolve — the default instance id equals
  // the driver slug.
  const favoritesSet = useMemo(() => {
    return new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  }, [favorites]);

  /**
   * Lookup table keyed by `instanceId`. Used for display name + driver
   * kind enrichment and for `ready`/enabled filtering before flattening
   * models into the search list.
   */
  const entryByInstanceId = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry])),
    [instanceEntries],
  );
  const matchesLockedProvider = useCallback(
    (entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">): boolean => {
      if (props.lockedProvider === null) return true;
      if (entry.driverKind !== props.lockedProvider) return false;
      if (!props.lockedContinuationGroupKey) return true;
      return entry.continuationGroupKey === props.lockedContinuationGroupKey;
    },
    [props.lockedContinuationGroupKey, props.lockedProvider],
  );

  const readyInstanceSet = useMemo(() => {
    const ready = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (isProviderInstancePickerReady(entry)) {
        ready.add(entry.instanceId);
      }
    }
    return ready;
  }, [instanceEntries]);

  // Flatten models into a searchable array. One pass over the
  // instance-keyed map; each model carries its instance id + driver kind
  // so the list row can render the right icon and display name without
  // another lookup.
  const flatModels = useMemo(() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        // Instance disappeared between renders (configuration change). Skip
        // its models — stale options shouldn't appear in the picker.
        continue;
      }
      if (!readyInstanceSet.has(instanceId)) {
        continue;
      }
      for (const model of models) {
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.isCustom !== undefined ? { isCustom: model.isCustom } : {}),
          ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
          instanceId,
          driverKind: entry.driverKind,
          ...(entry.presetId ? { presetId: entry.presetId } : {}),
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  }, [modelOptionsByInstance, entryByInstanceId, readyInstanceSet]);

  const isLocked = props.lockedProvider !== null;
  const isSearching = searchQuery.trim().length > 0;
  /** Whether the visible list can contain models from more than one provider. */
  const isCrossProviderList = isSearching || selectedInstanceId === "recommended";
  const lockedDisabledInstanceIds = useMemo(() => {
    if (!isLocked) {
      return undefined;
    }
    const disabled = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (!matchesLockedProvider(entry)) {
        disabled.add(entry.instanceId);
      }
    }
    return disabled;
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  const sidebarInstanceEntries = useMemo(() => {
    const enabledEntries = instanceEntries.filter(isProviderInstancePickerVisible);
    if (!isLocked) {
      return enabledEntries;
    }
    const available: ProviderInstanceEntry[] = [];
    const disabled: ProviderInstanceEntry[] = [];
    for (const entry of enabledEntries) {
      if (matchesLockedProvider(entry)) {
        available.push(entry);
      } else {
        disabled.push(entry);
      }
    }
    return [...available, ...disabled];
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  const showSidebar = sidebarInstanceEntries.length > 0;
  const instanceOrder = useMemo(
    () => instanceEntries.map((entry) => entry.instanceId),
    [instanceEntries],
  );
  const recommendedModelKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of instanceEntries) {
      const models = flatModels.filter((model) => model.instanceId === entry.instanceId);
      for (const model of selectRecommendedModels(entry.driverKind, models)) {
        keys.add(providerModelKey(model.instanceId, model.slug));
      }
    }
    return keys;
  }, [flatModels, instanceEntries]);

  // Filter models based on search query and selected instance
  const filteredModels = useMemo(() => {
    let result = flatModels;

    // Apply tokenized fuzzy search across the combined provider/model search fields.
    if (searchQuery.trim()) {
      const rankedMatches = result
        .map((model) => ({
          model,
          score: scoreModelPickerSearch(
            {
              name: model.name,
              ...(model.shortName ? { shortName: model.shortName } : {}),
              ...(model.subProvider ? { subProvider: model.subProvider } : {}),
              driverKind: model.driverKind,
              providerDisplayName: model.instanceDisplayName,
              isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
            },
            searchQuery,
          ),
          isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
          tieBreaker: buildModelPickerSearchText({
            name: model.name,
            ...(model.shortName ? { shortName: model.shortName } : {}),
            ...(model.subProvider ? { subProvider: model.subProvider } : {}),
            driverKind: model.driverKind,
            providerDisplayName: model.instanceDisplayName,
          }),
        }))
        .filter(
          (
            rankedModel,
          ): rankedModel is {
            model: ModelPickerItem;
            score: number;
            isFavorite: boolean;
            tieBreaker: string;
          } => rankedModel.score !== null,
        );

      // When searching, we only respect locked provider (by driver kind),
      // ignoring sidebar selection so account-scoped searches can find a
      // model before the user chooses a specific instance rail item.
      if (props.lockedProvider !== null) {
        const lockedProviderMatches: Array<(typeof rankedMatches)[number]> = [];
        for (const rankedModel of rankedMatches) {
          if (matchesLockedProvider(rankedModel.model)) {
            lockedProviderMatches.push(rankedModel);
          }
        }
        return lockedProviderMatches
          .toSorted((a, b) => {
            const scoreDelta = a.score - b.score;
            if (scoreDelta !== 0) {
              return scoreDelta;
            }
            if (a.isFavorite !== b.isFavorite) {
              return a.isFavorite ? -1 : 1;
            }
            return a.tieBreaker.localeCompare(b.tieBreaker);
          })
          .map((rankedModel) => rankedModel.model);
      }

      return rankedMatches
        .toSorted((a, b) => {
          const scoreDelta = a.score - b.score;
          if (scoreDelta !== 0) {
            return scoreDelta;
          }
          if (a.isFavorite !== b.isFavorite) {
            return a.isFavorite ? -1 : 1;
          }
          return a.tieBreaker.localeCompare(b.tieBreaker);
        })
        .map((rankedModel) => rankedModel.model);
    }

    if (props.lockedProvider !== null) {
      result = result.filter((m) => matchesLockedProvider(m));
      if (selectedInstanceId === "recommended") {
        result = result.filter(
          (m) =>
            (recommendedModelKeys.has(providerModelKey(m.instanceId, m.slug)) ||
              favoritesSet.has(providerModelKey(m.instanceId, m.slug))) &&
            (forYouAccountFilter === "all" || m.instanceId === forYouAccountFilter),
        );
      } else {
        result = result.filter((m) => m.instanceId === selectedInstanceId);
      }
    } else if (selectedInstanceId === "recommended") {
      result = result.filter(
        (m) =>
          (recommendedModelKeys.has(providerModelKey(m.instanceId, m.slug)) ||
            favoritesSet.has(providerModelKey(m.instanceId, m.slug))) &&
          (forYouAccountFilter === "all" || m.instanceId === forYouAccountFilter),
      );
    } else {
      result = result.filter((m) => m.instanceId === selectedInstanceId);
    }

    return sortProviderModelItems(result, {
      favoriteModelKeys: favoritesSet,
      groupFavorites: true,
      instanceOrder: selectedInstanceId === "recommended" ? instanceOrder : [],
    });
  }, [
    favoritesSet,
    flatModels,
    forYouAccountFilter,
    instanceOrder,
    matchesLockedProvider,
    props.lockedProvider,
    recommendedModelKeys,
    searchQuery,
    selectedInstanceId,
  ]);

  const handleModelSelect = useCallback(
    (modelSlug: string, instanceId: ProviderInstanceId) => {
      if (getModelDisabledReason?.(instanceId, modelSlug)) {
        return;
      }
      const options = modelOptionsByInstance.get(instanceId);
      if (!options) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        return;
      }
      // `resolveSelectableModel` uses the driver kind for normalization
      // (slug casing etc.). Custom instances share their driver's
      // normalization rules, so pass the driver kind here.
      const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
      if (resolvedModel) {
        onInstanceModelChange(instanceId, resolvedModel);
      }
    },
    [entryByInstanceId, getModelDisabledReason, modelOptionsByInstance, onInstanceModelChange],
  );

  const handleManageProviders = useCallback(() => {
    props.onRequestClose?.();
    void navigate({ to: "/settings/providers" });
  }, [navigate, props.onRequestClose]);

  const toggleFavorite = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const newFavorites = [...favorites];
      const index = newFavorites.findIndex((f) => f.provider === instanceId && f.model === model);
      if (index >= 0) {
        newFavorites.splice(index, 1);
      } else {
        newFavorites.push({ provider: instanceId, model });
      }
      updateSettings({ favorites: newFavorites });
    },
    [favorites, updateSettings],
  );

  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    let selectableModelIndex = 0;
    for (const model of filteredModels) {
      if (getModelDisabledReason?.(model.instanceId, model.slug)) {
        continue;
      }
      const jumpCommand = modelPickerJumpCommandForIndex(selectableModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(`${model.instanceId}:${model.slug}`, jumpCommand);
      selectableModelIndex += 1;
    }
    return mapping;
  }, [filteredModels, getModelDisabledReason]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const allModelKeys = useMemo(
    (): string[] => flatModels.map((model) => `${model.instanceId}:${model.slug}`),
    [flatModels],
  );
  const filteredModelKeys = useMemo(
    (): string[] => filteredModels.map((model) => `${model.instanceId}:${model.slug}`),
    [filteredModels],
  );
  const filteredModelByKey = useMemo(
    (): ReadonlyMap<string, ModelPickerItem> =>
      new Map(filteredModels.map((model) => [`${model.instanceId}:${model.slug}`, model] as const)),
    [filteredModels],
  );
  const sectionByModelKey = useMemo(() => {
    const sections = new Map<string, { label: string; hint?: string; separated?: boolean }>();
    if (isSearching || selectedInstanceId !== "recommended") return sections;

    const firstFavorite = filteredModels.find((model) =>
      favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
    );
    const firstRecommendation = filteredModels.find(
      (model) => !favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
    );
    if (firstFavorite) {
      sections.set(providerModelKey(firstFavorite.instanceId, firstFavorite.slug), {
        label: "Favorites",
      });
    }
    if (firstRecommendation) {
      sections.set(providerModelKey(firstRecommendation.instanceId, firstRecommendation.slug), {
        label: "Recommended",
        hint: "Provider picks",
        separated: Boolean(firstFavorite),
      });
    }
    return sections;
  }, [favoritesSet, filteredModels, isSearching, selectedInstanceId]);
  const selectedEntry =
    selectedInstanceId === "recommended"
      ? null
      : (entryByInstanceId.get(selectedInstanceId) ?? null);
  const headerTitle = isSearching
    ? "Search results"
    : selectedInstanceId === "recommended"
      ? "For you"
      : (selectedEntry?.displayName ?? "Models");
  const headerSubtitle = isSearching
    ? "Models and accounts matching your search"
    : selectedInstanceId === "recommended"
      ? "Your favorites and recommended models"
      : `${filteredModels.length} ${filteredModels.length === 1 ? "model" : "models"} available`;
  const updateModelListScrollFades = useCallback(() => {
    const scrollElement = modelListRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, []);
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        terminalOpen: props.terminalOpen,
        modelPickerOpen: true,
      }) as const,
    [props.terminalOpen],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);

  /**
   * Everything `renderItem` reads from its closure, bundled so the list
   * can see it change.
   *
   * LegendList caches each rendered row and only re-invokes `renderItem`
   * when that row's key, that row's own item data, or `extraData`
   * changes. Our items are plain model-key strings, so for any row whose
   * key survives a view switch — a favourited model also listed under
   * its own provider — key and item data are both identical and the row
   * is served from cache with the markup it was first built with. That
   * stranded the provider footer in the wrong state (shown under "All
   * Claude models", hidden under Favorites, depending on which list
   * rendered it first) and would do the same to jump labels, disabled
   * reasons, and the selected-row marker.
   */
  const rowRenderInputs = useMemo(
    () => ({
      favoritesSet,
      isCrossProviderList,
      isLocked,
      modelJumpLabelByKey,
      getModelDisabledReason,
      sectionByModelKey,
      activeInstanceId: props.activeInstanceId,
      activeModel: props.model,
    }),
    [
      favoritesSet,
      isCrossProviderList,
      isLocked,
      modelJumpLabelByKey,
      getModelDisabledReason,
      sectionByModelKey,
      props.activeInstanceId,
      props.model,
    ],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      const { instanceId, slug } = splitInstanceModelKey(targetModelKey);
      event.preventDefault();
      event.stopPropagation();
      handleModelSelect(slug, instanceId);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [handleModelSelect, keybindings, modelJumpModelKeys, modelJumpShortcutContext]);

  useLayoutEffect(() => {
    setShowTopScrollFade(false);
    setShowBottomScrollFade(filteredModelKeys.length > 5);
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      updateModelListScrollFades();
      nestedFrame = window.requestAnimationFrame(updateModelListScrollFades);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
  }, [filteredModelKeys, updateModelListScrollFades]);

  return (
    <TooltipProvider delay={0}>
      <Combobox
        inline
        items={allModelKeys}
        filteredItems={filteredModelKeys}
        filter={null}
        autoHighlight
        open
        virtualized
        value={`${props.activeInstanceId}:${props.model}`}
        onItemHighlighted={(modelKey, eventDetails) => {
          highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
          if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
            void modelListRef.current?.scrollIndexIntoView?.({
              index: eventDetails.index,
              animated: false,
            });
          }
        }}
        onValueChange={(modelKey) => {
          if (typeof modelKey !== "string") return;
          const { instanceId, slug } = splitInstanceModelKey(modelKey);
          handleModelSelect(slug, instanceId);
        }}
      >
        <div
          className="dropdown-glass model-picker-surface relative flex h-[min(32rem,calc(100vh-1rem))] w-[min(46rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg text-popover-foreground [clip-path:inset(0_round_var(--radius-lg))]"
          data-model-picker-content="true"
        >
          <div className="border-b border-border/65 bg-muted/20 p-3">
            <div className="rounded-md border border-border/75 bg-background/35 transition-[border-color,box-shadow] focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/15">
              <ComboboxInput
                ref={searchInputRef}
                className="[&_input]:h-9 [&_input]:font-sans"
                inputClassName="w-full bg-transparent text-sm"
                placeholder="Search models or accounts…"
                showTrigger={false}
                startAddon={<SearchIcon className="size-4 shrink-0 text-muted-foreground/60" />}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    props.onRequestClose?.();
                    return;
                  }
                  if (event.key === "Enter" && highlightedModelKeyRef.current) {
                    (
                      event as typeof event & { preventBaseUIHandler?: () => void }
                    ).preventBaseUIHandler?.();
                    event.preventDefault();
                    event.stopPropagation();
                    const { instanceId, slug } = splitInstanceModelKey(
                      highlightedModelKeyRef.current,
                    );
                    handleModelSelect(slug, instanceId);
                    return;
                  }
                  event.stopPropagation();
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onTouchStart={(event) => event.stopPropagation()}
                size="sm"
                unstyled
              />
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            {showSidebar ? (
              <ModelPickerSidebar
                selectedInstanceId={selectedInstanceId}
                onSelectInstance={handleSelectInstance}
                instanceEntries={sidebarInstanceEntries}
                showRecommended={!isLocked}
                onManageProviders={handleManageProviders}
                {...(lockedDisabledInstanceIds
                  ? {
                      disabledInstanceIds: lockedDisabledInstanceIds,
                      getDisabledInstanceTooltip: (entry: ProviderInstanceEntry) =>
                        `${entry.displayName} is unavailable in this thread. Start a new thread to switch providers.`,
                    }
                  : {})}
              />
            ) : null}

            <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/35">
              <header className="flex min-h-20 items-start justify-between gap-4 border-b border-border/55 px-5 py-3.5">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-foreground">{headerTitle}</h2>
                  <p className="mt-1 truncate text-xs text-muted-foreground/70">{headerSubtitle}</p>
                </div>
                {!isSearching && selectedInstanceId === "recommended" ? (
                  <Select<ProviderInstanceId | "all">
                    value={forYouAccountFilter}
                    onValueChange={(value) =>
                      value && setForYouAccountFilter(value as ProviderInstanceId | "all")
                    }
                  >
                    <SelectTrigger
                      size="xs"
                      className="shrink-0 bg-background/25 text-xs"
                      aria-label="Filter For you by account"
                    >
                      <SelectValue>
                        {forYouAccountFilter === "all"
                          ? "All accounts"
                          : (entryByInstanceId.get(forYouAccountFilter)?.displayName ??
                            "All accounts")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup
                      align="end"
                      alignItemWithTrigger={false}
                      positionerClassName="z-[70]"
                    >
                      <SelectItem value="all">All accounts</SelectItem>
                      {sidebarInstanceEntries.filter(isProviderInstancePickerReady).map((entry) => (
                        <SelectItem key={entry.instanceId} value={entry.instanceId}>
                          {entry.displayName}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
              </header>

              <div className="relative min-h-0 flex-1 overflow-hidden">
                <ComboboxListVirtualized className="model-picker-list size-full min-w-0 p-0">
                  <LegendList<string>
                    ref={modelListRef}
                    data={filteredModelKeys}
                    extraData={rowRenderInputs}
                    keyExtractor={(modelKey) => modelKey}
                    renderItem={({ item: modelKey, index }) => {
                      const model = filteredModelByKey.get(modelKey);
                      if (!model) return null;
                      const disabledReason =
                        getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
                      const section = sectionByModelKey.get(modelKey);
                      return (
                        <ModelListRow
                          key={modelKey}
                          index={index}
                          model={model}
                          instanceId={model.instanceId}
                          driverKind={model.driverKind}
                          presetId={model.presetId}
                          providerDisplayName={model.instanceDisplayName}
                          providerAccentColor={model.instanceAccentColor}
                          isFavorite={favoritesSet.has(modelKey)}
                          isSelected={modelKey === `${props.activeInstanceId}:${props.model}`}
                          showProvider={isCrossProviderList}
                          preferShortName={!isLocked}
                          useTriggerLabel={false}
                          showNewBadge={isModelPickerNewModel(model.driverKind, model.slug)}
                          sectionLabel={section?.label}
                          sectionHint={section?.hint}
                          sectionSeparated={section?.separated}
                          jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                          disabledReason={disabledReason}
                          onToggleFavorite={() => toggleFavorite(model.instanceId, model.slug)}
                        />
                      );
                    }}
                    estimatedItemSize={64}
                    drawDistance={560}
                    recycleItems
                    onLayout={updateModelListScrollFades}
                    onScroll={updateModelListScrollFades}
                    className={cn(
                      "scrollbar-gutter-both h-full overflow-x-hidden overscroll-y-contain px-2 py-1.5 [--fade-size:1.5rem]",
                      showTopScrollFade && "mask-t-from-[calc(100%-var(--fade-size))]",
                      showBottomScrollFade && "mask-b-from-[calc(100%-var(--fade-size))]",
                    )}
                  />
                </ComboboxListVirtualized>
              </div>
              <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
                No models found
              </ComboboxEmpty>
            </main>
          </div>
        </div>
      </Combobox>
    </TooltipProvider>
  );
});
