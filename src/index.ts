import { MockBiometricDevice } from './devices/mock-device.js';
import { WORKFLOW_CONFIGS } from './config/liveness.config.js';
import { FaceLivenessWorkflowController } from './workflows/workflow-controller.js';

async function runScenario(scenarioName: string, execute: () => Promise<void>) {
  console.log(`\n################################################################`);
  console.log(`SCENARIO: ${scenarioName}`);
  console.log(`################################################################`);
  await execute();
}

async function main() {
  console.log('MOSIP Decode 04 - Face Liveness & Presentation Attack Detection');
  console.log('TypeScript Engine Demonstration & Test Suite\n');

  // Scenario 1: Clean Resident Registration passing Passive Liveness directly
  await runScenario('1. Resident Registration - High Quality Passive Pass', async () => {
    const device = new MockBiometricDevice('CAM-001', 'L1-Biometric-Cam', 'L1', {
      isLiveHuman: true,
      passiveQualityScore: 0.95,
      isAttack: false,
    });
    await device.connect();

    const controller = new FaceLivenessWorkflowController(WORKFLOW_CONFIGS.RESIDENT);
    const result = await controller.runWorkflow(device);
    console.log(`Result: ${result.status} | Success: ${result.success}`);
    await device.disconnect();
  });

  // Scenario 2: Operator Authentication needing Active Challenge (e.g. Blink / Turn Head)
  await runScenario('2. Operator Authentication - Passive Fallback to Active Challenge', async () => {
    // Threshold for operator is 0.90; initial frame gives 0.88, triggering challenge
    const device = new MockBiometricDevice('CAM-002', 'L0-Desktop-Cam', 'L0', {
      isLiveHuman: true,
      passiveQualityScore: 0.88,
      simulatedAction: 'NONE',
    });
    await device.connect();

    // After 800ms, user responds by turning head / blinking
    setTimeout(() => {
      console.log('-> [User Simulation] Performing requested action: BLINK...');
      device.setSimulationOptions({ simulatedAction: 'BLINK' });
    }, 800);

    const controller = new FaceLivenessWorkflowController(WORKFLOW_CONFIGS.OPERATOR);
    const result = await controller.runWorkflow(device);
    console.log(`Result: ${result.status} | Success: ${result.success}`);
    await device.disconnect();
  });

  // Scenario 3: Presentation Attack Detection (Printed Photo Spoof)
  await runScenario('3. Presentation Attack Detection - Photo Spoof Rejection', async () => {
    const device = new MockBiometricDevice('CAM-003', 'L1-Biometric-Cam', 'L1', {
      attackType: 'PRINTED_PHOTO',
    });
    await device.connect();

    const controller = new FaceLivenessWorkflowController(WORKFLOW_CONFIGS.SUPERVISOR);
    const result = await controller.runWorkflow(device);
    console.log(`Result: ${result.status} | Success: ${result.success} | Attack: ${result.padResult?.attackType}`);
    await device.disconnect();
  });
}

main().catch(console.error);
