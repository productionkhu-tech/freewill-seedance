// Model facts that BOTH the client and server.ts need to agree on.
//
// Deliberately free of React / zustand / any UI import: server.ts bundles this file, and
// pulling the store in would drag the whole frontend into the server bundle.
//
// Why it exists: these ids used to be hand-synced across the two sides with a comment
// ("must match MODELS[] in src/store.ts"). That is fine for a label and not fine for a
// permission — a grant that drifts is a grant that silently stops working.

/** 2.5 Demo. Rides its own BytePlus key + endpoint, so it is never billed to a tracker project. */
export const DEMO_MODEL_ID = 'seedance-2-5-demo';

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
