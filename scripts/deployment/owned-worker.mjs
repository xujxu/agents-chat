import path from 'node:path';
import { hasUnsettledWorker } from './worker-errors.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const methods = ['run', 'closeAdmission', 'stop', 'join', 'observe'];
const text = value => typeof value === 'string' && value.length > 0
  && value.length <= 4096 && !/[\0\r\n]/.test(value);

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`Invalid owned worker ${label}.`);
  }
  return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])));
}

function captureOwner(value) {
  const owner = exact(value,
    ['project', 'operationId', 'workerId', 'controllerIdentity'], 'owner');
  if (!Object.values(owner).every(text) || !path.isAbsolute(owner.project)
    || !uuid.test(owner.workerId)) throw new Error('Invalid owned worker owner.');
  return owner;
}

function captureDomain(value, owner) {
  let identity;
  if (value?.kind === 'systemd') {
    identity = exact(value,
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
    identity = exact(value,
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

function failureCause(errors) {
  return errors.length === 1 ? errors[0]
    : new AggregateError(errors, 'Owned worker execution, cleanup or receipt recording failed.');
}

export async function runOwnedWorker({ owner: suppliedOwner, signal }, { record, prepare }) {
  const owner = captureOwner(suppliedOwner);
  if (typeof record !== 'function' || typeof prepare !== 'function') {
    throw new Error('Invalid owned worker adapters.');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', cancel, { once: true });
  let domain = null;
  let handle;
  let attempted = false;
  let prepared = false;
  let uncertain = false;
  let result;
  const errors = [];
  const receipt = phase => Object.freeze({ version: 1, owner, phase, domain });
  const write = async phase => {
    try { await record(receipt(phase)); }
    catch (error) { uncertain = true; throw error; }
  };
  try {
    await record(receipt('intent'));
    try {
      controller.signal.throwIfAborted();
      attempted = true;
      handle = await prepare({ owner, signal: controller.signal });
      if (!handle || methods.some(name => typeof handle[name] !== 'function')) {
        throw new Error('Incomplete owned worker handle.');
      }
      domain = captureDomain(handle.identity, owner);
      prepared = true;
      controller.signal.throwIfAborted();
      await write('owned');
      controller.signal.throwIfAborted();
      await write('admitted');
      controller.signal.throwIfAborted();
      result = await handle.run({ signal: controller.signal });
      controller.signal.throwIfAborted();
    } catch (error) {
      errors.push(error);
      if (attempted && !prepared) uncertain = true;
    }

    // Close the grant signal before awaiting any native controller cleanup.
    controller.abort(new Error('Owned worker admission closed.'));
    let cleanupFailed = false;
    if (handle) {
      for (const method of ['closeAdmission', 'stop', 'join']) {
        try {
          if (typeof handle[method] !== 'function') {
            throw new Error(`Missing owned worker ${method} operation.`);
          }
          await handle[method]();
        } catch (error) {
          errors.push(error);
          cleanupFailed = true;
          uncertain = true;
        }
      }
      if (prepared && !cleanupFailed) {
        try {
          const observation = exact(await handle.observe(), ['identity', 'empty'], 'observation');
          const observed = captureDomain(observation.identity, owner);
          if (observation.empty !== true
            || Object.keys(domain).some(key => domain[key] !== observed[key])) {
            throw new Error('Owned worker extinction was not confirmed for the original domain.');
          }
        } catch (error) {
          errors.push(error);
          uncertain = true;
        }
      }
    }
    uncertain ||= errors.some(hasUnsettledWorker);
    if (!uncertain) {
      try { await write('settled'); }
      catch (error) { errors.push(error); }
    }
    if (uncertain) {
      try { await write('blocked'); }
      catch (error) { errors.push(error); }
      throw Object.assign(new Error(
        'Owned worker settlement is uncertain; retain lock and backup. Do not restore or restart.',
        { cause: failureCause(errors) },
      ), { code: 'DEPLOYMENT_WORKER_UNSETTLED', recoveryAllowed: false });
    }
    if (errors.length) throw failureCause(errors);
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
