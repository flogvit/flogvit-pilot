import { LABELS } from "./github";

export type PipelineStage = "verify" | "review" | "audit" | "merge";

export interface PipelineJob {
  prNumber: number;
  prTitle: string;
  headBranch: string;
  stage: PipelineStage;
}

export const STAGE_LABELS: Record<PipelineStage, string> = {
  verify: LABELS.needsVerify,
  review: LABELS.needsReview,
  audit: LABELS.needsAudit,
  merge: LABELS.approved,
};

export const PIPELINE_STAGES: PipelineStage[] = ["verify", "review", "audit", "merge"];
