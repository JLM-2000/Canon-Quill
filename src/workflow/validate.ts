import type { Workflow, WorkflowState } from "./schema.js";

export interface WorkflowValidationResult {
  ok: boolean;
  issues: string[];
}

const transitionKeys = [
  "on_success",
  "on_failure",
  "on_incomplete",
  "on_pass",
  "on_fail",
  "on_critical_fail"
] as const;

export function validateWorkflow(workflow: Workflow): WorkflowValidationResult {
  const issues: string[] = [];
  const stateNames = new Set(Object.keys(workflow.states));

  if (!stateNames.has(workflow.initial_state)) {
    issues.push(`Initial state '${workflow.initial_state}' is not defined.`);
  }

  for (const terminal of workflow.terminal_states) {
    if (!stateNames.has(terminal)) issues.push(`Terminal state '${terminal}' is not defined.`);
  }

  for (const [name, state] of Object.entries(workflow.states)) {
    for (const target of collectTargets(state)) {
      if (!stateNames.has(target)) issues.push(`State '${name}' targets missing state '${target}'.`);
    }

    if (!workflow.terminal_states.includes(name) && collectTargets(state).length === 0) {
      issues.push(`Non-terminal state '${name}' has no outgoing transition.`);
    }

    if (state.requires_user_review && !state.transitions && !state.on_success) {
      issues.push(`User-review state '${name}' has no explicit approval transition.`);
    }
  }

  const reachable = findReachable(workflow);
  for (const name of stateNames) {
    if (!reachable.has(name)) issues.push(`State '${name}' is not reachable from '${workflow.initial_state}'.`);
  }

  return { ok: issues.length === 0, issues };
}

function collectTargets(state: WorkflowState): string[] {
  const targets: string[] = [];
  for (const key of transitionKeys) {
    const value = state[key];
    if (typeof value === "string") targets.push(value);
  }
  if (state.transitions) targets.push(...Object.values(state.transitions));
  return targets;
}

function findReachable(workflow: Workflow): Set<string> {
  const seen = new Set<string>();
  const queue = [workflow.initial_state];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const state = workflow.states[current];
    if (!state) continue;
    for (const target of collectTargets(state)) queue.push(target);
  }

  return seen;
}
