import { runWindowsSetupScript } from './powershell.mjs';

export function assertWindowsOverrides(context, model) {
  const wanted = model === 'disabled' ? { VOICE_ENABLED: '0' } : {
    VOICE_ENABLED: '1', VOICE_MODEL: model, VOICE_RESOURCE_POLICY: 'standard',
  };
  for (const name of ['machine', 'user', 'volatile']) {
    const values = context[name];
    if (!values || typeof values !== 'object' || Array.isArray(values)
      || Object.values(values).some(value => typeof value !== 'string')) throw new Error('Invalid Windows setup observation.');
    if (Object.entries(values).some(([key, value]) => key.toUpperCase().startsWith('VOICE_') && (
      Object.hasOwn(wanted, key.toUpperCase()) ? value !== wanted[key.toUpperCase()] : model !== 'disabled'
    ))) throw new Error(`Conflicting voice override in Windows ${name} environment; update that source before configuration.`);
  }
}

export async function windowsSetupContext(serviceUser) {
  const context = JSON.parse(await runWindowsSetupScript('setup-context.ps1', {
    ...(serviceUser ? { VOICE_SERVICE_USER: serviceUser } : {}),
  }));
  if (!context || !/^S-1-(?:\d+-)*\d+$/.test(context.currentSid)
    || !/^S-1-(?:\d+-)*\d+$/.test(context.serviceSid)) throw new Error('Invalid Windows service identity.');
  return context;
}
