import type { AgentDefinitionReportDto, ShadowedAgent } from "../../lib/tauri";
import { MutedCaption } from "../MutedCaption";
import { shadowHeading } from "./agentLabels";

/** The loser lines for one row (see the render site above). */
export function ShadowReport({
  row,
  needle,
}: {
  row: AgentDefinitionReportDto;
  needle: string;
}) {
  // `?? []` is the same IPC tolerance `SkillsDialog` keeps for a row that
  // genuinely predates the field — a bare `flatMap` over such a row yields
  // `undefined` entries that throw on the first property access.
  const losers: ShadowedAgent[] = (row.shadowed ?? []).filter(
    (loser) => needle === "" || loser.name.toLowerCase().includes(needle),
  );
  if (losers.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 pt-1">
      <MutedCaption as="p">
        {shadowHeading(row.scope, losers.length)}
      </MutedCaption>
      {losers.map((loser) => (
        <MutedCaption
          as="div"
          key={loser.path}
          className="flex min-w-0 items-center gap-2"
        >
          <span className="min-w-0 shrink-0">{loser.name}</span>
          <span className="min-w-0 truncate" title={loser.path}>
            {loser.path}
          </span>
        </MutedCaption>
      ))}
    </div>
  );
}
