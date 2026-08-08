// Chapter-to-chapter flow. `buildOpeningBrief` turns the ledger into what the
// next chapter must honour; `validateFlow` checks a draft against the previous
// handoff.
//
// The validator is conservative on purpose: it reports what it can prove from
// structured state and stays quiet where only a human can judge, because a gate
// that cries wolf gets switched off.

import {
  handoffFor,
  latestCharacterState,
  type ChapterHandoff,
  type ContinuityLedger,
  type Thread
} from "./ledger.js";
import { words } from "../style/text.js";

export type FlowSeverity = "blocker" | "major" | "minor";

export interface FlowIssue {
  kind:
    | "location-jump"
    | "knowledge-violation"
    | "condition-ignored"
    | "timeline-regression"
    | "stale-thread"
    | "overdue-thread"
    | "unpaid-promise"
    | "dropped-hook";
  severity: FlowSeverity;
  message: string;
  /** What the editing agent should do about it. */
  fix: string;
}

export interface FlowReport {
  chapter: number;
  issues: FlowIssue[];
  verdict: "pass" | "revise" | "fail";
}

/** How many chapters a thread may go untouched before it reads as forgotten. */
const staleAfter: Record<Thread["weight"], number> = { main: 3, subplot: 5, minor: 8 };

/**
 * Everything chapter N must honour, derived from chapter N-1's handoff. This
 * goes into the drafting prompt as a checklist the chapter is measured against.
 */
export function buildOpeningBrief(ledger: ContinuityLedger, chapter: number): string {
  const previous = handoffFor(ledger, chapter - 1);
  const lines: string[] = [`# Opening contract, chapter ${chapter}`, ""];

  // Canon and thread state stay binding even when the preceding handoff is
  // missing. Only the previous-chapter section is conditional; dropping threads
  // with it would disable payoff tracking when continuity is already shaky.
  if (ledger.projectShape === "series" && ledger.inheritedCanon.length > 0) {
    lines.push("## Inherited series canon (binding)", "");
    for (const fact of ledger.inheritedCanon) lines.push(`- ${fact}`);
    lines.push("");
  }

  if (!previous) {
    lines.push(
      chapter <= 1
        ? "This is the opening chapter. No prior handoff exists."
        : `No handoff was recorded for chapter ${chapter - 1}. Per-character continuity cannot be enforced for this chapter; the thread and promise obligations below still apply.`,
      ""
    );
  } else {
    lines.push(
      `## Where chapter ${previous.chapter} left the story`,
      "",
      `- **Location:** ${previous.endsAtLocation}`,
      `- **In-world time:** ${previous.timeline.endsAt}`,
      `- **Closing beat:** ${previous.closingBeat}`,
      `- **Open question it left:** ${previous.openQuestion}`,
      ""
    );

    if (previous.characters.length > 0) {
      lines.push(
        "## Character state you must open consistent with",
        "",
        "| Character | Where | Condition | Leaving on | Knows |",
        "|---|---|---|---|---|"
      );
      for (const character of previous.characters) {
        lines.push(
          `| ${character.name} | ${character.location} | ${character.condition || "not set"} | ${character.emotionalState || "not set"} | ${
            character.knows.length > 0 ? character.knows.join("; ") : "not set"
          } |`
        );
      }
      lines.push("");
    }
  }

  const live = ledger.threads.filter((thread) => thread.status === "open" || thread.status === "advanced");
  if (live.length > 0) {
    lines.push("## Open threads", "");
    for (const thread of live.sort((a, b) => weightRank(b.weight) - weightRank(a.weight))) {
      const age = chapter - thread.lastTouchedChapter;
      const due = thread.mustResolveBy ? `, due by ch.${thread.mustResolveBy}` : "";
      const stale = age >= staleAfter[thread.weight] ? " going cold, touch it or resolve it**" : "";
      lines.push(`- *(${thread.weight}${due})* ${thread.question}, last advanced ch.${thread.lastTouchedChapter}${stale}`);
    }
    lines.push("");
  }

  const unpaid = ledger.promises.filter((promise) => promise.paidOffChapter === undefined);
  if (unpaid.length > 0) {
    lines.push("## Planted but unpaid", "");
    for (const promise of unpaid) lines.push(`- ${promise.setup} (planted ch.${promise.plantedChapter})`);
    lines.push("");
  }

  lines.push(
    "## Rules for this chapter's opening",
    "",
    `1. Do not relocate a character without showing or acknowledging the move.`,
    `2. Do not let anyone act on a fact not listed under **Knows** for them.`,
    `3. Carry forward every listed condition, or show it resolving.`,
    previous
      ? `4. Move in-world time forward from ${previous.timeline.endsAt}, unless this chapter is a marked flashback.`
      : `4. Move in-world time forward, unless this chapter is a marked flashback.`,
    previous
      ? `5. Answer, advance, or deliberately deepen: *${previous.openQuestion}*`
      : `5. Close on a question that gives the next chapter something to answer.`,
    ""
  );

  return lines.join("\n");
}

/**
 * Validate a drafted chapter against the previous handoff.
 *
 * `draft` is the chapter prose; `claimed` is the handoff the drafting agent
 * produced for this chapter (its own account of where things now stand).
 */
export function validateFlow(
  ledger: ContinuityLedger,
  chapter: number,
  draft: string,
  claimed?: ChapterHandoff
): FlowReport {
  const issues: FlowIssue[] = [];
  const previous = handoffFor(ledger, chapter - 1);
  const opening = openingWindow(draft);

  if (previous) {
    // Relocation with no travel shown and no reference to where they were.
    const openingMentionsPrevLocation = mentions(opening, previous.endsAtLocation);
    for (const character of previous.characters) {
      if (!mentions(opening, character.name)) continue;
      const claimedState = claimed?.characters.find(
        (entry) => entry.name.toLowerCase() === character.name.toLowerCase()
      );
      if (!claimedState) continue;
      if (
        normalise(claimedState.location) !== normalise(character.location) &&
        !openingMentionsPrevLocation &&
        !showsTransit(draft)
      ) {
        issues.push({
          kind: "location-jump",
          severity: "blocker",
          message:
            `${character.name} ended chapter ${previous.chapter} in ${character.location} but this chapter places them ` +
            `in ${claimedState.location} with no travel shown and no reference to ${character.location}.`,
          fix: `Either open in ${character.location}, or add a beat that moves ${character.name} between the two.`
        });
      }

      if (character.condition && claimedState.condition === "" && !mentions(draft, character.condition)) {
        issues.push({
          kind: "condition-ignored",
          severity: "major",
          message: `${character.name} ended chapter ${previous.chapter} "${character.condition}"; this chapter never carries it or resolves it.`,
          fix: `Show the ${character.condition} constraining them, or show it treated.`
        });
      }
    }

    // Time must not run backwards without a declared flashback.
    if (claimed && !claimed.timeline.isFlashback && previous.timeline.endsAt) {
      const previousDay = dayNumber(previous.timeline.endsAt);
      const currentDay = dayNumber(claimed.timeline.endsAt);
      if (previousDay !== undefined && currentDay !== undefined && currentDay < previousDay) {
        issues.push({
          kind: "timeline-regression",
          severity: "blocker",
          message: `Chapter ${chapter} ends on day ${currentDay}, before chapter ${previous.chapter} ended (day ${previousDay}), and is not marked as a flashback.`,
          fix: `Fix the chapter's in-world dating, or mark it as a deliberate flashback.`
        });
      }
    }

    // The previous chapter's hook should not evaporate.
    if (previous.openQuestion && !touchesQuestion(draft, previous.openQuestion)) {
      issues.push({
        kind: "dropped-hook",
        severity: "major",
        message: `Chapter ${previous.chapter} closed on "${previous.openQuestion}" and this chapter never engages it.`,
        fix: `Answer it, advance it, or have a character consciously defer it, but acknowledge it.`
      });
    }
  }

  // Someone acting on a fact they were never given.
  for (const state of claimed?.characters ?? []) {
    const known = latestCharacterState(ledger, state.name);
    if (!known) continue;
    const gained = state.knows.filter((fact) => !known.knows.includes(fact));
    for (const fact of gained) {
      if (mentions(draft, fact)) continue;
      issues.push({
        kind: "knowledge-violation",
        severity: "major",
        message: `${state.name} now knows "${fact}" but the chapter never shows them learning it.`,
        fix: `Show the moment ${state.name} learns "${fact}", or remove it from their knowledge.`
      });
    }
  }

  // Threads going cold or past their deadline.
  for (const thread of ledger.threads) {
    if (thread.status === "resolved" || thread.status === "abandoned") continue;
    const age = chapter - thread.lastTouchedChapter;

    if (thread.mustResolveBy !== undefined && chapter > thread.mustResolveBy) {
      issues.push({
        kind: "overdue-thread",
        severity: "blocker",
        message: `"${thread.question}" was due to resolve by chapter ${thread.mustResolveBy} and is still open at ${chapter}.`,
        fix: `Resolve it in this chapter, or move the deadline in the chapter plan deliberately.`
      });
      continue;
    }

    if (age >= staleAfter[thread.weight] && !touchesQuestion(draft, thread.question)) {
      issues.push({
        kind: "stale-thread",
        severity: thread.weight === "main" ? "major" : "minor",
        message: `"${thread.question}" (${thread.weight}) has not been advanced since chapter ${thread.lastTouchedChapter}.`,
        fix: `Give it at least one beat here, or accept it is being deliberately held.`
      });
    }
  }

  // Setups the book is running out of room to pay off.
  const remaining = ledger.plannedChapters - chapter;
  if (remaining <= 2) {
    for (const promise of ledger.promises.filter((entry) => entry.paidOffChapter === undefined)) {
      issues.push({
        kind: "unpaid-promise",
        severity: remaining <= 0 ? "blocker" : "major",
        message: `"${promise.setup}" was planted in chapter ${promise.plantedChapter} and is still unpaid with ${Math.max(remaining, 0)} chapters left.`,
        fix: `Pay it off, or cut the setup from chapter ${promise.plantedChapter}.`
      });
    }
  }

  issues.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  return {
    chapter,
    issues,
    verdict: issues.some((issue) => issue.severity === "blocker")
      ? "fail"
      : issues.some((issue) => issue.severity === "major")
        ? "revise"
        : "pass"
  };
}

/** Render a flow report as markdown for the editing agent and the UI. */
export function renderFlowReport(report: FlowReport): string {
  const lines = [`# Chapter Flow Report, Chapter ${report.chapter}`, "", `**Verdict:** ${report.verdict.toUpperCase()}`, ""];
  if (report.issues.length === 0) {
    lines.push("Chapter connects cleanly to the previous handoff. No flow breaks detected.", "");
    return lines.join("\n");
  }
  lines.push("| Severity | Issue | Fix |", "|---|---|---|");
  for (const issue of report.issues) {
    lines.push(`| ${issue.severity} | ${escapePipes(issue.message)} | ${escapePipes(issue.fix)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** The first 250 words, where continuity breaks are most jarring. */
function openingWindow(draft: string): string {
  return words(draft).slice(0, 250).join(" ");
}

function mentions(text: string, phrase: string): boolean {
  if (!phrase.trim()) return false;
  return normalise(text).includes(normalise(phrase));
}

/** Does the chapter engage a question, judged by its distinctive content words? */
function touchesQuestion(draft: string, question: string): boolean {
  const keyTerms = words(question).filter((word) => word.length > 4);
  if (keyTerms.length === 0) return true; // nothing distinctive to look for
  const draftWords = new Set(words(draft));
  const hits = keyTerms.filter((term) => draftWords.has(term)).length;
  return hits / keyTerms.length >= 0.4;
}

/** Look for any sign the chapter shows movement between places. */
function showsTransit(draft: string): boolean {
  return /\b(?:rode|drove|walked|travell?ed|flew|sailed|arrived|journey|the road|set out|left for|made (?:it|their way)|by morning they|crossed)\b/i.test(
    draft
  );
}

/** Extract a day number from strings like "Day 4, dusk". */
function dayNumber(value: string): number | undefined {
  const match = /day\s+(\d+)/i.exec(value);
  return match ? Number(match[1]) : undefined;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function severityRank(severity: FlowSeverity): number {
  return severity === "blocker" ? 3 : severity === "major" ? 2 : 1;
}

function weightRank(weight: Thread["weight"]): number {
  return weight === "main" ? 3 : weight === "subplot" ? 2 : 1;
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}
