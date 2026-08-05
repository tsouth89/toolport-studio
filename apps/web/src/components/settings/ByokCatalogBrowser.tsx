"use client";

import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { ByokCatalogModel, ProviderInstanceId } from "@toolport-studio/contracts";

import { loadByokCatalog } from "../../byokCatalogAtoms";
import { usePrimaryEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * How many rows to render before asking the user to narrow the search.
 *
 * The catalog is a few hundred models. Rendering all of them is fine for the
 * DOM but useless to read, and a list that long hides the search box's
 * purpose. The count of what is hidden is always shown, so the cap never
 * looks like "that's all there is".
 */
const VISIBLE_LIMIT = 40;

function matches(model: ByokCatalogModel, query: string): boolean {
  if (query.length === 0) return true;
  const haystack = `${model.slug} ${model.displayName}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .every((term) => haystack.includes(term));
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export interface ByokCatalogBrowserProps {
  readonly instanceId: ProviderInstanceId;
  /** Slugs already on this instance, so they render as added rather than addable. */
  readonly selectedSlugs: ReadonlySet<string>;
  readonly onAdd: (slug: string) => void;
}

/**
 * Browse the models an API-key provider actually serves.
 *
 * Exists because a router's lineup is not something a user can be expected to
 * recall: typing `z-ai/glm-5.2` from memory is a worse experience than picking
 * it from a list, and a typo silently produces a model that never appears.
 *
 * The catalog is fetched on open rather than with the settings page — it is a
 * few hundred rows per instance that almost nobody opens.
 */
export function ByokCatalogBrowser({ instanceId, selectedSlugs, onAdd }: ByokCatalogBrowserProps) {
  const environment = usePrimaryEnvironment();
  const runLoad = useAtomCommand(loadByokCatalog);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ReadonlyArray<ByokCatalogModel> | null>(null);
  const [source, setSource] = useState<"live" | "cache" | "seeds" | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "failed">("idle");

  const load = async () => {
    if (!environment) return;
    setStatus("loading");
    const result = await runLoad({ environmentId: environment.environmentId, instanceId });
    if (result._tag === "Success") {
      setModels(result.value.models);
      setSource(result.value.source);
      setStatus("idle");
      return;
    }
    setStatus("failed");
  };

  const filtered = useMemo(
    () => (models ?? []).filter((model) => matches(model, query.trim())),
    [models, query],
  );
  const visible = filtered.slice(0, VISIBLE_LIMIT);
  const hidden = filtered.length - visible.length;

  if (!open) {
    return (
      <Button
        className="mt-2 self-start"
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          if (models === null) void load();
        }}
      >
        <SearchIcon className="size-3.5" />
        Browse models
      </Button>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name or slug…"
          spellCheck={false}
        />
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Done
        </Button>
      </div>

      {status === "loading" ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading catalog…</p>
      ) : null}

      {status === "failed" ? (
        <p className="mt-3 text-xs text-destructive">
          Could not load the catalog. You can still add a slug by hand below.
        </p>
      ) : null}

      {status === "idle" && source === "seeds" ? (
        // Distinguishing this matters: an instance that has never started has
        // no cached catalog, and a short list with no explanation reads as
        // "this provider only offers these".
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the built-in shortlist. Start this instance once to load the provider&rsquo;s full
          catalog.
        </p>
      ) : null}

      {status === "idle" && models !== null && filtered.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No models match that search.</p>
      ) : null}

      <ul className="mt-2 max-h-80 overflow-y-auto">
        {visible.map((model) => {
          const added = selectedSlugs.has(model.slug);
          return (
            <li
              key={model.slug}
              className="flex items-center gap-3 border-b border-border/50 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm">{model.displayName}</span>
                  {model.supportsVision ? (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      vision
                    </Badge>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono">{model.slug}</span>
                  <span className="shrink-0">{formatContextWindow(model.contextWindow)} ctx</span>
                  {model.reasoningEfforts.length > 0 ? (
                    <span className="shrink-0">{model.reasoningEfforts.join("/")}</span>
                  ) : null}
                </div>
              </div>
              <Button
                className="shrink-0"
                variant={added ? "ghost" : "outline"}
                size="sm"
                disabled={added}
                onClick={() => onAdd(model.slug)}
              >
                {added ? <CheckIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
                {added ? "Added" : "Add"}
              </Button>
            </li>
          );
        })}
      </ul>

      {hidden > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {hidden} more {hidden === 1 ? "match" : "matches"}. Narrow the search to see them.
        </p>
      ) : null}
    </div>
  );
}
