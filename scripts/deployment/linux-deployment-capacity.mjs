import { stat, statfs } from 'node:fs/promises';

export async function requireLinuxDeploymentSpace(requirements) {
  const budgets = new Map();
  for (const [directory, required] of requirements) {
    if (typeof required !== 'bigint' || required <= 0n) throw new Error('Deployment space requires positive byte budgets.');
    const { dev } = await stat(directory, { bigint: true });
    const space = await statfs(directory, { bigint: true });
    const prior = budgets.get(dev) ?? { required: 0n, available: space.bavail * space.bsize };
    prior.required += required;
    budgets.set(dev, prior);
  }
  if ([...budgets.values()].some(value => value.required > value.available)) {
    throw new Error('Insufficient space for complete backup and declared build budget.');
  }
}
