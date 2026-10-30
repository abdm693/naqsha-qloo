/**
 * Where the home on screen is. Naqsha started in Pakistan (marla, LDA); everywhere else plots read in square feet and the
 * checks are "local rules". ProjectShell sets it from the brief; plotLabel and the compliance line read it.
 */
import type { Brief } from "@contracts/api-types";

const PK_CITIES = new Set(["lahore", "islamabad", "karachi", "rawalpindi", "faisalabad", "multan", "gujranwala", "peshawar",
  "quetta", "hyderabad", "sialkot", "bahawalpur", "sargodha", "abbottabad", "murree"]);

let intl = false;

export function isPakistan(brief: Brief | null | undefined): boolean {
  const city = String(brief?.city ?? "").trim().toLowerCase();
  return !city || PK_CITIES.has(city);
}

export function setLocaleFrom(brief: Brief | null | undefined): void {
  intl = !isPakistan(brief);
}

export function isIntl(): boolean {
  return intl;
}

/** "LDA" in Pakistan, "local rules" elsewhere. */
export function rulesLabel(): string {
  return intl ? "local rules" : "LDA";
}
