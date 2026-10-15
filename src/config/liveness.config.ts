import { WorkflowRole, WorkflowConfig } from '../types/index.js';

export const WORKFLOW_CONFIGS: Record<WorkflowRole, WorkflowConfig> = {
  RESIDENT: {
    role: 'RESIDENT',
    passiveConfidenceThreshold: 0.80,
    activeLivenessEnabled: true,
    challengeTimeoutMs: 8000,
    maxRetries: 3,
    challengePool: ['BLINK', 'SMILE', 'TURN_HEAD_LEFT', 'TURN_HEAD_RIGHT'],
  },
  OPERATOR: {
    role: 'OPERATOR',
    passiveConfidenceThreshold: 0.90, // higher security for operator
    activeLivenessEnabled: true,
    challengeTimeoutMs: 6000,
    maxRetries: 2,
    challengePool: ['BLINK', 'TURN_HEAD_LEFT', 'TURN_HEAD_RIGHT'],
  },
  SUPERVISOR: {
    role: 'SUPERVISOR',
    passiveConfidenceThreshold: 0.92, // highest security for supervisory override
    activeLivenessEnabled: true,
    challengeTimeoutMs: 5000,
    maxRetries: 2,
    challengePool: ['BLINK', 'SMILE', 'TURN_HEAD_LEFT', 'TURN_HEAD_RIGHT'],
  },
};
