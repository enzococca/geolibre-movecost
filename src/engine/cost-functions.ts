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
  /** Unit of the accumulated cost, as movecost's own catalogue names it. */
  costUnit: string;
  uses: WalkerParam[];
}

export const COST_FUNCTIONS: CostFunction[] = [
  // --- walking time --------------------------------------------------------
  { id: "t", label: "Tobler — on-path (default)", group: "Walking time", unit: "time", costUnit: "hours", uses: ["N"] },
  { id: "tofp", label: "Tobler — off-path", group: "Walking time", unit: "time", costUnit: "hours", uses: [] },
  { id: "mp", label: "Márquez-Pérez et al. — modified Tobler", group: "Walking time", unit: "time", costUnit: "hours", uses: ["N"] },
  { id: "icmonp", label: "Irmischer-Clarke — male, on-path", group: "Walking time", unit: "time", costUnit: "hours", uses: ["N"] },
  { id: "icmoffp", label: "Irmischer-Clarke — male, off-path", group: "Walking time", unit: "time", costUnit: "hours", uses: [] },
  { id: "icfonp", label: "Irmischer-Clarke — female, on-path", group: "Walking time", unit: "time", costUnit: "hours", uses: ["N"] },
  { id: "icfoffp", label: "Irmischer-Clarke — female, off-path", group: "Walking time", unit: "time", costUnit: "hours", uses: [] },
  { id: "ug", label: "Uriarte González", group: "Walking time", unit: "time", costUnit: "hours", uses: ["N"] },
  { id: "ma", label: "Marín Arroyo", group: "Walking time", unit: "time", costUnit: "hours", uses: ["N"] },
  { id: "alb", label: "Alberti — pastoral foraging excursions", group: "Walking time", unit: "time", costUnit: "hours", uses: [] },
  { id: "gkrs", label: "Garmy, Kaddouri, Rozenblat & Schneider", group: "Walking time", unit: "time", costUnit: "hours", uses: ["N"] },
  { id: "r", label: "Rees", group: "Walking time", unit: "time", costUnit: "hours", uses: ["N"] },
  { id: "ks", label: "Kondo-Seino", group: "Walking time", unit: "time", costUnit: "hours", uses: ["N"] },
  { id: "trp", label: "Tripcevich", group: "Walking time", unit: "time", costUnit: "hours", uses: ["N"] },

  // --- wheeled vehicles ----------------------------------------------------
  { id: "wcs", label: "Wheeled-vehicle critical slope", group: "Wheeled vehicles", unit: "vehicle", costUnit: "abstract cost", uses: ["N", "slCrit"] },

  // --- abstract cost -------------------------------------------------------
  { id: "ree", label: "Relative energetic expenditure", group: "Abstract cost", unit: "abstract", costUnit: "abstract cost", uses: ["N"] },
  { id: "b", label: "Bellavia", group: "Abstract cost", unit: "abstract", costUnit: "abstract cost", uses: ["N"] },
  { id: "e", label: "Eastman", group: "Abstract cost", unit: "abstract", costUnit: "abstract cost", uses: ["N"] },

  // --- metabolic energy expenditure ---------------------------------------
  { id: "p", label: "Pandolf et al.", group: "Metabolic energy", unit: "energy", costUnit: "Megawatts", uses: ["N", "W", "L", "V"] },
  { id: "pcf", label: "Pandolf et al. — downhill correction", group: "Metabolic energy", unit: "energy", costUnit: "Megawatts", uses: ["N", "W", "L", "V"] },
  { id: "m", label: "Minetti et al.", group: "Metabolic energy", unit: "energy", costUnit: "J/(kg·m)", uses: ["N"] },
  { id: "hrz", label: "Herzog", group: "Metabolic energy", unit: "energy", costUnit: "J/(kg·m)", uses: ["N"] },
  { id: "vl", label: "Van Leusen", group: "Metabolic energy", unit: "energy", costUnit: "Megawatts", uses: ["N", "W", "L", "V"] },
  { id: "ls", label: "Llobera-Sluckin", group: "Metabolic energy", unit: "energy", costUnit: "kJ/m", uses: ["N"] },
  { id: "a", label: "Ardigò et al.", group: "Metabolic energy", unit: "energy", costUnit: "J/(kg·m)", uses: ["N", "W", "L", "V"] },
  { id: "h", label: "Hare", group: "Metabolic energy", unit: "energy", costUnit: "cal/km", uses: ["N"] },
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

/**
 * Human-readable unit for accumulated-cost legends and path labels.
 *
 * movecost 3.0 publishes the unit of every function in `mc_cost_functions()`,
 * so a metabolic result is labelled with what it actually is — Megawatts,
 * J/(kg·m), kJ/m, cal/km — rather than a hedge covering all of them.
 */
export function costUnitLabel(id: string, timeUnit: "h" | "m"): string {
  const funct = getCostFunction(id);
  if (funct.unit === "time") return timeUnit === "h" ? "hours" : "minutes";
  return funct.costUnit;
}
