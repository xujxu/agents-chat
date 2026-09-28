export const authenticationEnvironmentNames = Object.freeze([
  'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'NODE_ENV', 'ADMIN_USERNAME', 'ADMIN_PASSWORD',
  'AZURE_AD_CLIENT_ID', 'AZURE_AD_CLIENT_SECRET', 'AZURE_AD_TENANT_ID',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_ALLOWED_EMAILS', 'ADMIN_EMAILS',
]);

function refusal(check) {
  return Object.assign(new Error(`Configuration compatibility refused: ${check}.`), {
    code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED', check,
    nextAction: 'Inspect the named effective runtime settings before updating; do not print secret values.',
  });
}

export function inspectConfigurationCompatibility({ profile, environment }) {
  if (profile !== 'agents-chat-auth-638c553') throw refusal('unsupported-profile');
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw refusal('environment');
  const values = {};
  for (const name of authenticationEnvironmentNames) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    if (descriptor && (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
      || descriptor.value.length > 65536 || /[\0\r\n]/.test(descriptor.value))) throw refusal(name);
    values[name] = descriptor?.value ?? '';
  }
  if (!values.NEXTAUTH_SECRET.trim() || values.NEXTAUTH_SECRET === 'change-me-to-a-random-string') {
    throw refusal('NEXTAUTH_SECRET');
  }
  let url;
  try { url = new URL(values.NEXTAUTH_URL); }
  catch { throw refusal('NEXTAUTH_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw refusal('NEXTAUTH_URL');
  }
  if (values.NODE_ENV && values.NODE_ENV !== 'production') throw refusal('NODE_ENV');
  const providers = [];
  if (Boolean(values.ADMIN_USERNAME) !== Boolean(values.ADMIN_PASSWORD)) throw refusal('ADMIN_USERNAME/ADMIN_PASSWORD');
  if (values.ADMIN_USERNAME && values.ADMIN_PASSWORD) {
    if (!values.ADMIN_USERNAME.trim() || !values.ADMIN_PASSWORD.trim()) throw refusal('ADMIN_USERNAME/ADMIN_PASSWORD');
    providers.push('credentials');
  }
  if (values.AZURE_AD_CLIENT_ID) {
    if (!values.AZURE_AD_CLIENT_ID.trim()) throw refusal('AZURE_AD_CLIENT_ID');
    if (Object.hasOwn(environment, 'AZURE_AD_TENANT_ID') && !values.AZURE_AD_TENANT_ID.trim()) throw refusal('AZURE_AD_TENANT_ID');
    providers.push('azure-ad');
  }
  if (Boolean(values.GITHUB_CLIENT_ID) !== Boolean(values.GITHUB_CLIENT_SECRET)) throw refusal('GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET');
  if (values.GITHUB_CLIENT_ID && values.GITHUB_CLIENT_SECRET) {
    if (!values.GITHUB_CLIENT_ID.trim() || !values.GITHUB_CLIENT_SECRET.trim()) throw refusal('GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET');
    const emails = value => value.split(',').map(email => email.trim()).filter(Boolean);
    const explicit = emails(values.GITHUB_ALLOWED_EMAILS);
    if (!(explicit.length ? explicit : emails(values.ADMIN_EMAILS)).length) throw refusal('GITHUB_ALLOWED_EMAILS/ADMIN_EMAILS');
    providers.push('github');
  }
  if (!providers.length) throw refusal('authentication-provider');
  return { status: 'configuration-supported', profile, providers };
}
