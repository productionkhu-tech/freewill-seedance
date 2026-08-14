// Model facts that BOTH the client and server.ts need to agree on.
//
// Deliberately free of React / zustand / any UI import: server.ts bundles this file, and
// pulling the store in would drag the whole frontend into the server bundle.
//
// Why it exists: these ids used to be hand-synced across the two sides with a comment
// ("must match MODELS[] in src/store.ts"). That is fine for a label and not fine for a
// permission — a grant that drifts is a grant that silently stops working.

/**
 * Model ids that no longer exist → what they become.
 *
 * `seedance-2-5-demo` was the BytePlus demo endpoint (its own key, its own contract, never
 * billed to a project). The demo ended 2026-08-14 and the model is gone from the app.
 *
 * It cannot simply be deleted, because projects and past messages still hold that id.
 * Hydration turns an unknown model into the app default, which is 2.0 — that would quietly
 * halve the image cap (30 → 9) and clamp saved durations (30s → 15s) on work that was set
 * up for 2.5. The official 2.5 row has the identical capability set, so mapping there
 * changes nothing about the project except which contract pays, which is now the only
 * option anyway.
 */
export const LEGACY_MODEL_IDS: Record<string, string> = {
  'seedance-2-5-demo': 'dreamina-seedance-2-5-260628',
};

/** Current id for a possibly-retired one. Unknown ids pass through untouched. */
export function resolveModelId(id: string): string {
  return LEGACY_MODEL_IDS[id] || id;
}

/**
 * model id → the Project_Status column that must be true for the SELECTED billing project
 * before this model may be used. Absent = open to everyone, which is every other model.
 *
 * Adding a gated model is one line here: the client's isModelAllowed() and the server's
 * pre-send check both read this map, so neither can be updated without the other.
 */
export const MODEL_GRANTS: Record<string, 'allow25'> = {
  'dreamina-seedance-2-5-260628': 'allow25',
};
