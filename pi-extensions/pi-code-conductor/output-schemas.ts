import { Type, Static } from "@sinclair/typebox";

export const InvestigationResultSchema = Type.Object({
  completed: Type.Boolean(),
  summary: Type.String(),
  files_examined: Type.Optional(Type.Array(Type.String())),
  findings: Type.Optional(Type.Array(Type.String())),
  feasibility: Type.Optional(Type.String()),
});

export const ImplementationResultSchema = Type.Object({
  completed: Type.Boolean(),
  summary: Type.String(),
  files_changed: Type.Optional(Type.Array(Type.String())),
  issues: Type.Optional(Type.Array(Type.String())),
});

export const VerificationResultSchema = Type.Object({
  verdict: Type.Union([Type.Literal("APPROVED"), Type.Literal("NOT_APPROVED"), Type.Literal("BLOCKED")]),
  criteria_passed: Type.Optional(Type.Array(Type.String())),
  criteria_failed: Type.Optional(Type.Array(Type.String())),
  issues: Type.Optional(Type.Array(Type.String())),
});

export const ReviewResultSchema = Type.Object({
  verdict: Type.String(),
  issues: Type.Optional(Type.Array(Type.Object({
    severity: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    file: Type.String(),
    description: Type.String(),
  }))),
  summary: Type.String(),
});

export const DebugResultSchema = Type.Object({
  completed: Type.Boolean(),
  summary: Type.String(),
  root_cause: Type.Optional(Type.String()),
  fix_applied: Type.Optional(Type.String()),
  files_changed: Type.Optional(Type.Array(Type.String())),
});

export const SimplificationResultSchema = Type.Object({
  completed: Type.Boolean(),
  summary: Type.String(),
  files_changed: Type.Optional(Type.Array(Type.String())),
  complexity_reduction: Type.Optional(Type.String()),
});

export const OUTPUT_SCHEMAS: Record<string, any> = {
  "investigation-result": InvestigationResultSchema,
  "implementation-result": ImplementationResultSchema,
  "verification-result": VerificationResultSchema,
  "review-result": ReviewResultSchema,
  "debug-result": DebugResultSchema,
  "simplification-result": SimplificationResultSchema,
};
