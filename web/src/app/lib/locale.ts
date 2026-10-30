/**
 * How plot sizes are said for the home on screen. No place is the default: the family's own units, else what the place's
 * home profile says, and LDA, DHA and Bahria plots in marla. ProjectShell sets it from the brief; plotLabel and the
 * compliance line read it.
 */
import type { Brief } from "@contracts/api-types";

const LAHORE_AUTHORITIES = new Set(["LDA", "DHA", "BAHRIA"]);

let intl = false;

/** Whether this home's plot is spoken of in marla. */
export function isPakistan(brief: Brief | null | undefined): boolean {
  const units = brief?.units ?? brief?.local?.units;
  return units ? units === "marla" : LAHORE_AUTHORITIES.has(String(brief?.authority ?? "").toUpperCase());
}

export function setLocaleFrom(brief: Brief | null | undefined): void {
  intl = !isPakistan(brief);
}

export function isIntl(): boolean {
  return intl;
}

/** "Mid-row" where plots sit in rows, "Inside lot" elsewhere. */
export function midLabel(): string {
  return intl ? "Inside lot" : "Mid-row";
}

/** "LDA rules" in Pakistan, "Local rules" elsewhere: a heading. */
export function rulesTitle(): string {
  return intl ? "Local rules" : "LDA rules";
}

/** "LDA" in Pakistan, "local rules" elsewhere. */
export function rulesLabel(): string {
  return intl ? "local rules" : "LDA";
}
