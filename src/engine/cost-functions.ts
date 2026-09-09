/**
 * The movecost cost-function catalogue.
 *
 * `unit` drives how results are labelled and whether the time-unit selector is
 * offered; `uses` drives which walker parameters the form shows, so the panel
 * never asks for a body weight that the chosen function ignores.
 */

export type CostUnit = "time" | "energy" | "abstract" | "vehicle";
export type WalkerParam = "W" | "L" | "N" | "V" | "slCrit";

export interface CostFunction {
  id: string;
  label: string;
  group: string;
  unit: CostUnit;
  uses: WalkerParam[];
}

export const COST_FUNCTIONS: CostFunction[] = [
  // --- walking time --------------------------------------------------------
  { id: "t", label: "Tobler — on-path (default)", group: "Walking time", unit: "time", uses: [] },
  { id: "tofp", label: "Tobler — off-path", group: "Walking time", unit: "time", uses: [] },
  { id: "mp", label: "Márquez-Pérez et al. — modified Tobler", group: "Walking time", unit: "time", uses: [] },
  { id: "icmonp", label: "Irmischer-Clarke — male, on-path", group: "Walking time", unit: "time", uses: [] },
  { id: "icmoffp", label: "Irmischer-Clarke — male, off-path", group: "Walking time", unit: "time", uses: [] },
  { id: "icfonp", label: "Irmischer-Clarke — female, on-path", group: "Walking time", unit: "time", uses: [] },
  { id: "icfoffp", label: "Irmischer-Clarke — female, off-path", group: "Walking time", unit: "time", uses: [] },
  { id: "ug", label: "Uriarte González", group: "Walking time", unit: "time", uses: [] },
  { id: "ma", label: "Marín Arroyo", group: "Walking time", unit: "time", uses: [] },
  { id: "alb", label: "Alberti — pastoral foraging excursions", group: "Walking time", unit: "time", uses: [] },
  { id: "gkrs", label: "Garmy, Kaddouri, Rozenblat & Schneider", group: "Walking time", unit: "time", uses: [] },
  { id: "r", label: "Rees", group: "Walking time", unit: "time", uses: [] },
  { id: "ks", label: "Kondo-Seino", group: "Walking time", unit: "time", uses: [] },
  { id: "trp", label: "Tripcevich", group: "Walking time", unit: "time", uses: [] },

  // --- wheeled vehicles ----------------------------------------------------
  { id: "wcs", label: "Wheeled-vehicle critical slope", group: "Wheeled vehicles", unit: "vehicle", uses: ["slCrit"] },

  // --- abstract cost -------------------------------------------------------
  { id: "ree", label: "Relative energetic expenditure", group: "Abstract cost", unit: "abstract", uses: [] },
  { id: "b", label: "Bellavia", group: "Abstract cost", unit: "abstract", uses: [] },
  { id: "e", label: "Eastman", group: "Abstract cost", unit: "abstract", uses: [] },

  // --- metabolic energy expenditure ---------------------------------------
  { id: "p", label: "Pandolf et al.", group: "Metabolic energy", unit: "energy", uses: ["W", "L", "N", "V"] },
  { id: "pcf", label: "Pandolf et al. — downhill correction", group: "Metabolic energy", unit: "energy", uses: ["W", "L", "N", "V"] },
  { id: "m", label: "Minetti et al.", group: "Metabolic energy", unit: "energy", uses: [] },
  { id: "hrz", label: "Herzog", group: "Metabolic energy", unit: "energy", uses: [] },
  { id: "vl", label: "Van Leusen", group: "Metabolic energy", unit: "energy", uses: ["W", "L", "N", "V"] },
  { id: "ls", label: "Llobera-Sluckin", group: "Metabolic energy", unit: "energy", uses: [] },
  { id: "a", label: "Ardigò et al.", group: "Metabolic energy", unit: "energy", uses: ["V"] },
  { id: "h", label: "Hare", group: "Metabolic energy", unit: "energy", uses: [] },
];

const BY_ID = new Map(COST_FUNCTIONS.map((f) => [f.id, f]));

export function getCostFunction(id: string): CostFunction {
  return BY_ID.get(id) ?? COST_FUNCTIONS[0];
}

export function isTimeFunction(id: string): boolean {
  return getCostFunction(id).unit === "time";
}

export const COST_FUNCTION_GROUPS = [
  "Walking time",
  "Wheeled vehicles",
  "Abstract cost",
  "Metabolic energy",
] as const;

/** Human-readable unit for accumulated-cost legends and path labels. */
export function costUnitLabel(id: string, timeUnit: "h" | "m"): string {
  switch (getCostFunction(id).unit) {
    case "time":
      return timeUnit === "h" ? "hours" : "minutes";
    case "energy":
      return "energy (J or kcal, per the chosen function)";
    case "vehicle":
      return "relative cost";
    default:
      return "abstract cost";
  }
}
