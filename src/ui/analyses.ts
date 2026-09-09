import type { AnalysisId } from "../engine/types";

/**
 * What each movecost analysis needs and produces.
 *
 * The panel is driven entirely from this table: which point sets to ask for,
 * which extra parameters to show, and how to name the layers that come back.
 * Keeping it declarative means adding an analysis is a data change, not a new
 * branch through the UI code.
 */

export interface AnalysisSpec {
  id: AnalysisId;
  label: string;
  description: string;
  rFunction: string;
  origin: { label: string; min: number; max?: number };
  destination: { label: string; min: number; max?: number } | null;
  supportsBarrier: boolean;
  /** Extra controls, rendered in the order given. */
  extras: ExtraField[];
  /** Result key -> display name and default styling. */
  layers: Record<string, { label: string; kind: "line" | "point" | "polygon" | "raster" }>;
}

export type ExtraField =
  | { kind: "select"; key: string; label: string; options: { value: string; label: string }[]; hint?: string }
  | { kind: "number"; key: string; label: string; min?: number; max?: number; step?: number; defaultValue?: number; hint?: string }
  | { kind: "numberList"; key: string; label: string; hint?: string }
  | { kind: "boolean"; key: string; label: string; hint?: string };

export const ANALYSES: AnalysisSpec[] = [
  {
    id: "paths",
    label: "Least-cost paths",
    description:
      "Accumulated cost surface around the origin, plus the least-cost path to each destination and the isolines of equal cost.",
    rFunction: "mc_surface() + mc_paths() + mc_accum()",
    origin: { label: "Origin", min: 1, max: 1 },
    destination: { label: "Destinations", min: 1 },
    supportsBarrier: true,
    extras: [
      {
        kind: "number",
        key: "breaks",
        label: "Isoline interval",
        min: 0,
        step: 0.05,
        hint: "In the cost unit of the chosen function. Leave at 0 to let movecost use a tenth of the range.",
      },
      {
        kind: "boolean",
        key: "returnBase",
        label: "Also compute the return paths",
        hint: "Slope-dependent cost is asymmetric, so the way back is rarely the same line.",
      },
    ],
    layers: {
      lcps: { label: "Least-cost paths", kind: "line" },
      lcpsBack: { label: "Return paths", kind: "line" },
      isolines: { label: "Cost isolines", kind: "line" },
      destinations: { label: "Destinations with cost", kind: "point" },
      accumulated: { label: "Accumulated cost", kind: "raster" },
      costSurface: { label: "Cost surface", kind: "raster" },
    },
  },
  {
    id: "corridor",
    label: "Least-cost corridor",
    description:
      "The band of terrain whose combined cost from both locations stays low — where movement plausibly happened, rather than one idealised line.",
    rFunction: "mc_surface() + mc_corridor()",
    origin: { label: "Location A", min: 1, max: 1 },
    destination: { label: "Location B", min: 1, max: 1 },
    supportsBarrier: true,
    extras: [
      {
        kind: "select",
        key: "corridorMethod",
        label: "Formulation",
        options: [
          { value: "reach", label: "Reach — symmetric, both directions summed" },
          { value: "through", label: "Through — the A → B near-optimal band" },
        ],
        hint: "\"Reach\" is the classic corridor; \"through\" keeps only routes that actually go from A to B.",
      },
      {
        kind: "boolean",
        key: "rescale",
        label: "Rescale the corridor to 0–1",
        hint: "Makes corridors from different runs comparable.",
      },
    ],
    layers: {
      lcpAtoB: { label: "Path A → B", kind: "line" },
      lcpBtoA: { label: "Path B → A", kind: "line" },
      corridor: { label: "Least-cost corridor", kind: "raster" },
    },
  },
  {
    id: "network",
    label: "Least-cost network",
    description:
      "Paths between a set of locations — all pairs, or only neighbours — with the cost matrix between them.",
    rFunction: "mc_surface() + mc_network()",
    origin: { label: "Locations", min: 2 },
    destination: null,
    supportsBarrier: true,
    extras: [
      {
        kind: "select",
        key: "netwType",
        label: "Network type",
        options: [
          { value: "allpairs", label: "All pairs of locations" },
          { value: "neigh", label: "Neighbouring locations only" },
        ],
      },
      {
        kind: "boolean",
        key: "lcpDensity",
        label: "Compute path density",
        hint: "Counts how many paths cross each cell — slower, but shows the corridors the network converges on.",
      },
    ],
    layers: {
      network: { label: "Network paths", kind: "line" },
      nodes: { label: "Locations (numbered)", kind: "point" },
      density: { label: "Path density (%)", kind: "raster" },
    },
  },
  {
    id: "allocation",
    label: "Cost allocation",
    description:
      "Assigns every cell to its cheapest origin — the cost-distance equivalent of Thiessen polygons, and a common first pass at territories.",
    rFunction: "mc_surface() + mc_alloc()",
    origin: { label: "Origins", min: 2 },
    destination: null,
    supportsBarrier: true,
    extras: [
      {
        kind: "boolean",
        key: "isolines",
        label: "Also draw cost isolines",
      },
      {
        kind: "number",
        key: "breaks",
        label: "Isoline interval",
        min: 0,
        step: 0.05,
        hint: "Only used when isolines are enabled. Leave at 0 for a tenth of the range.",
      },
    ],
    layers: {
      boundaries: { label: "Allocation zones", kind: "polygon" },
      isolines: { label: "Cost isolines", kind: "line" },
      allocation: { label: "Cost allocation", kind: "raster" },
    },
  },
  {
    id: "boundary",
    label: "Cost boundaries (isochrones)",
    description:
      "The area reachable from each origin within a given cost — an hour's walk, say — returned as a polygon with its area and perimeter.",
    rFunction: "mc_surface() + mc_boundary()",
    origin: { label: "Origins", min: 1 },
    destination: null,
    supportsBarrier: true,
    extras: [
      {
        kind: "numberList",
        key: "contValue",
        label: "Cost limits",
        hint: "Required. Comma-separated, in the cost unit of the chosen function (e.g. 1, 2 for one- and two-hour walks).",
      },
    ],
    layers: {
      boundaries: { label: "Cost boundaries", kind: "polygon" },
      accumulated: { label: "Accumulated cost", kind: "raster" },
    },
  },
  {
    id: "rank",
    label: "Ranked alternative paths",
    description:
      "Several plausible routes between two points, ranked from optimal to sub-optimal — useful when the single best path is an artefact of the DTM.",
    rFunction: "mc_surface() + mc_rank()",
    origin: { label: "Origin", min: 1, max: 1 },
    destination: { label: "Destination", min: 1, max: 1 },
    supportsBarrier: true,
    extras: [
      {
        kind: "number",
        key: "lcpN",
        label: "Number of paths",
        min: 2,
        max: 8,
        step: 1,
        defaultValue: 3,
        hint: "The optimal path plus its alternatives.",
      },
      {
        kind: "number",
        key: "penalty",
        label: "Detour penalty",
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 0.01,
        hint: "How strongly each alternative is pushed away from the paths already found. Lower means further apart.",
      },
    ],
    layers: {
      rankedPaths: { label: "Ranked paths", kind: "line" },
      corridor: { label: "Least-cost corridor", kind: "raster" },
    },
  },
];

export function getAnalysis(id: AnalysisId): AnalysisSpec {
  return ANALYSES.find((a) => a.id === id) ?? ANALYSES[0];
}
