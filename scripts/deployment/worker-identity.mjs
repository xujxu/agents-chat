import path from 'node:path';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const text = value => typeof value === 'string' && value.length > 0
  && value.length <= 4096 && !/[\0\r\n]/.test(value);

export function captureWorkerFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`Invalid owned worker ${label}.`);
  }
  return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])));
}

export function captureOwner(value) {
  const owner = captureWorkerFields(value,
    ['project', 'operationId', 'workerId', 'controllerIdentity'], 'owner');
  if (!Object.values(owner).every(text) || !path.isAbsolute(owner.project)
    || !uuid.test(owner.workerId)) throw new Error('Invalid owned worker owner.');
  return owner;
}

export function captureDomain(value, owner) {
  let identity;
  if (value?.kind === 'systemd') {
    identity = captureWorkerFields(value,
      ['kind', 'bootId', 'manager', 'unit', 'invocationId', 'controlGroup'], 'domain');
    const unit = `agents-deploy-${owner.workerId}.service`;
    if (!Object.values(identity).every(text) || !uuid.test(identity.bootId)
      || identity.manager !== 'system' || identity.unit !== unit
      || !/^[a-f0-9]{32}$/.test(identity.invocationId)
      || !identity.controlGroup.startsWith('/')
      || !identity.controlGroup.endsWith(`/${unit}`)
      || identity.controlGroup.slice(1).split('/').some(part => ['', '.', '..'].includes(part))) {
      throw new Error('Invalid owned worker systemd identity.');
    }
  } else if (value?.kind === 'windows-job') {
    identity = captureWorkerFields(value,
      ['kind', 'name', 'generation', 'accountSid', 'sessionId', 'ownerIdentity'], 'domain');
    if (identity.name !== `Local\\agents-deploy-${owner.workerId}`
      || identity.generation !== owner.workerId || !text(identity.accountSid)
      || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(identity.accountSid)
      || !Number.isSafeInteger(identity.sessionId) || identity.sessionId < 0
      || identity.ownerIdentity !== owner.controllerIdentity) {
      throw new Error('Invalid owned worker Windows Job identity.');
    }
  } else {
    throw new Error('Unsupported owned worker domain.');
  }
  return identity;
}
