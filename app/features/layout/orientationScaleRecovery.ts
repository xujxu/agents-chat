export type NavigatorIdentity = Pick<
  Navigator,
  'userAgent' | 'platform' | 'maxTouchPoints'
>;

const IOS_DEVICE_PATTERN = /iPad|iPhone|iPod/i;
const SCALE_DIRECTIVE_PATTERN =
  /^(?:initial-scale|minimum-scale|maximum-scale)\s*=/i;

export function isIOSDevice(identity: NavigatorIdentity): boolean {
  return IOS_DEVICE_PATTERN.test(identity.userAgent)
    || (identity.platform === 'MacIntel' && identity.maxTouchPoints > 1);
}

export function buildScaleLockedViewportContent(content: string): string {
  const retainedDirectives = content
    .split(',')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => !SCALE_DIRECTIVE_PATTERN.test(directive));

  return [
    ...retainedDirectives,
    'initial-scale=1',
    'minimum-scale=1',
    'maximum-scale=1',
  ].join(', ');
}
