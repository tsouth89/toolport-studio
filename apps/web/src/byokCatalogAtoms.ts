import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@toolport-studio/client-runtime/state/runtime";

import { connectionAtomRuntime } from "./connection/runtime";
import { fetchByokCatalog, type FetchByokCatalogInput } from "./byokCatalog";

const byokCatalogScheduler = createAtomCommandScheduler();

/**
 * Serial per instance: opening the browser twice quickly (React strict mode,
 * an impatient click) should not put two catalog reads in flight for the same
 * provider.
 */
export const loadByokCatalog = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:byok:load-catalog",
  scheduler: byokCatalogScheduler,
  concurrency: {
    mode: "serial" as const,
    key: (input: FetchByokCatalogInput) => input.instanceId,
  },
  execute: (input: FetchByokCatalogInput) => fetchByokCatalog(input),
});
