import { z } from "zod";

const StateName = z.string().min(1);

export const WorkflowStateSchema = z
  .object({
    agent: z.string().min(1),
    description: z.string().optional(),
    requires_user_input: z.boolean().optional(),
    requires_user_review: z.boolean().optional(),
    transitions: z.record(StateName).optional(),
    on_success: StateName.optional(),
    on_failure: StateName.optional(),
    on_incomplete: StateName.optional(),
    on_pass: StateName.optional(),
    on_fail: StateName.optional(),
    on_critical_fail: StateName.optional()
  })
  .passthrough();

export const WorkflowSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().min(1),
  initial_state: StateName,
  terminal_states: z.array(StateName).min(1),
  global: z.record(z.unknown()).optional(),
  states: z.record(WorkflowStateSchema)
});

export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
