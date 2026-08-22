/**
 * @file layersSlice.ts
 * @description State slice managing the lifecycle, visibility, and loading status of data layers (plugins).
 */

import type { StateCreator } from "zustand";
import type { AppStore } from "./store";

// ─── Layers Slice ────────────────────────────────────────────
/**
 * Runtime state for a single data layer.
 */
export interface LayerState {
    /** Whether the layer is currently active and fetching/rendering data. */
    enabled: boolean;
    /** The number of entities currently loaded in this layer. */
    entityCount: number;
    /** Whether the layer is currently waiting for a network response. */
    loading: boolean;
}

/**
 * Zustand state slice for managing plugin layers.
 */
export interface LayersSlice {
    /** Map of plugin IDs to their current LayerState. */
    layers: Record<string, LayerState>;
    /** Toggles the active status of a layer. */
    toggleLayer: (pluginId: string) => void;
    /** Explicitly enables or disables a specific layer. */
    setLayerEnabled: (pluginId: string, enabled: boolean) => void;
    /** Updates the entity count displayed in the UI for a specific layer. */
    setEntityCount: (pluginId: string, count: number) => void;
    /** Updates the loading state indicator for a specific layer. */
    setLayerLoading: (pluginId: string, loading: boolean) => void;
    /** Initializes a new layer entry in the state if it doesn't already exist. */
    initLayer: (pluginId: string, defaultEnabled?: boolean) => void;
    /** Completely removes a layer from the state. */
    removeLayer: (pluginId: string) => void;
}

export const createLayersSlice: StateCreator<AppStore, [], [], LayersSlice> = (set) => ({
    layers: {},
    toggleLayer: (pluginId) => set((state) => ({
            layers: {
                ...state.layers,
                [pluginId]: {
                    ...state.layers[pluginId],
                    enabled: !state.layers[pluginId]?.enabled,
                },
            },
        })),
    setLayerEnabled: (pluginId, enabled) => set((state) => ({
            layers: {
                ...state.layers,
                [pluginId]: { ...state.layers[pluginId], enabled },
            },
        })),
    // `layers` object identity is load-bearing. Eight components subscribe to the
    // whole map via `useStore((s) => s.layers)` -- including GlobeView, the Cesium
    // host -- and none of src/components uses React.memo. A no-op write that still
    // spreads a fresh object therefore re-renders all eight on every plugin data
    // tick, cascading into per-entity work across every enabled layer.
    //
    // These two setters are the per-tick hot path: REST polls emit a loading flag
    // and an entity count every cycle, per plugin, whether or not the value moved.
    // Returning `{}` is a no-op merge in zustand -- subscribers are not notified.
    // Guard only on a genuinely unchanged value; an uninitialized layer has no
    // `existing`, so the write still falls through and creates it.
    setEntityCount: (pluginId, count) => set((state) => {
        const existing = state.layers[pluginId];
        if (existing && existing.entityCount === count) return {};
        return {
            layers: {
                ...state.layers,
                [pluginId]: { ...existing, entityCount: count },
            },
        };
    }),
    setLayerLoading: (pluginId, loading) => set((state) => {
        const existing = state.layers[pluginId];
        if (existing && existing.loading === loading) return {};
        return {
            layers: {
                ...state.layers,
                [pluginId]: { ...existing, loading },
            },
        };
    }),
    initLayer: (pluginId, defaultEnabled = false) => set((state) => ({
            layers: {
                ...state.layers,
                [pluginId]: state.layers[pluginId] || { enabled: defaultEnabled, entityCount: 0, loading: false },
            },
        })),
    removeLayer: (pluginId) => set((state) => {
        const copy = { ...state.layers };
        delete copy[pluginId];
        return { layers: copy };
    }),
});
