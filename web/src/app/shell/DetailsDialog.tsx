/** "Details" from the title menu: the brief and the rules in plain words, plus when things happened. */
import type { Project } from "@contracts/api-types";
import { BUDGET_LABEL, FACING_LABEL, plotLabel, spaceLabel } from "@/api/domain";
import { relativeTime } from "@/app/lib/utils";
import { Button } from "@/app/ui/Button";
import { Dialog } from "@/app/ui/Dialog";
import { sentenceCase } from "@/app/plan/model";
import { solarLabel, tankLabel } from "@/app/lib/roof";

export function DetailsDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project: Project }) {
  const b = project.brief;
  const e = project.envelope;
  const rows: [string, string][] = [];
  if (b) {
    rows.push(["Plot", b.plot?.width_ft ? `${plotLabel(b.plot.area_marla)} · ${b.plot.width_ft}′ × ${b.plot.depth_ft}′ · ${b.plot.corner ? "Corner" : "Mid-row"}` : "Not yet"]);
    rows.push(["Where", [b.scheme, b.city].filter(Boolean).join(", ") || "Lahore"]);
    if (b.facing) rows.push(["Front faces", FACING_LABEL[b.facing] ?? b.facing]);
    const home = [
      b.storeys ? `${b.storeys} ${b.storeys === 1 ? "storey" : "storeys"}` : null,
      b.bedrooms ? `${b.bedrooms} ${b.bedrooms === 1 ? "bedroom" : "bedrooms"}` : null,
      b.bathrooms ? `${b.bathrooms} ${b.bathrooms === 1 ? "bath" : "baths"}` : null,
    ].filter(Boolean);
    rows.push(["Home", home.length ? home.join(" · ") : "Not yet"]);
    if (b.spaces?.length) rows.push(["Spaces", b.spaces.map(spaceLabel).join(", ")]);
    if (b.style) rows.push(["Style", sentenceCase(b.style)]);
    if (b.budget) rows.push(["Budget", BUDGET_LABEL[b.budget] ?? b.budget]);
    if (b.water_tank) rows.push(["Water tank", tankLabel(b.water_tank) ?? b.water_tank]);
    if (b.solar) rows.push(["Roof", solarLabel(b.solar) ?? b.solar]);
  }
  if (e) {
    rows.push([`${e.authority ?? ""} rules`.trim(), `${e.band}: ${e.max_coverage_pct}% coverage, ${e.max_height_ft} ft high, setbacks ${e.setbacks_ft.front}′ front and ${e.setbacks_ft.rear}′ rear`]);
  }
  // The latest version and its age, said the same way as the Versions popover ("v2 · 2 hours ago").
  const latestV = [...project.versions].sort((a, b) => b.n - a.n)[0];
  rows.push(["Versions", latestV ? `${project.versions.length} · latest v${latestV.n}, ${relativeTime(latestV.created_at)}` : "None yet"]);
  rows.push(["Started", relativeTime(project.created_at)]);
  rows.push(["Last change", relativeTime(project.updated_at)]);

  return (
    <Dialog open={open} onClose={onClose} title={project.name} description="What Naqsha is working from." actions={<Button onClick={onClose}>Close</Button>}>
      <dl className="grid grid-cols-[minmax(92px,auto)_1fr] gap-x-4 gap-y-2.5 text-[14px] leading-5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {b?.preferences && b.preferences.length > 0 && (
        <div className="mt-5">
          <p className="mb-1.5 text-[13px] font-medium text-ink-3">Your wishes</p>
          <ul className="list-disc pl-5 text-[14px] leading-5 text-ink">
            {b.preferences.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
