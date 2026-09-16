import { expect, test } from '@playwright/test';
import {
  buildScaleLockedViewportContent,
  isIOSDevice,
} from '../app/features/layout/orientationScaleRecovery';

test('detects iPhone and desktop-UA iPadOS without matching Android', () => {
  expect(isIOSDevice({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)',
    platform: 'iPhone',
    maxTouchPoints: 5,
  })).toBe(true);
  expect(isIOSDevice({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  })).toBe(true);
  expect(isIOSDevice({
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 7)',
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
  })).toBe(false);
});

test('builds a temporary scale lock without losing unrelated directives', () => {
  expect(buildScaleLockedViewportContent(
    'width=device-width, initial-scale=1, interactive-widget=resizes-content',
  )).toBe(
    'width=device-width, interactive-widget=resizes-content, initial-scale=1, minimum-scale=1, maximum-scale=1',
  );
});

test('replaces every existing scale directive case-insensitively', () => {
  expect(buildScaleLockedViewportContent(
    'width=device-width, INITIAL-SCALE=2, minimum-scale=.5, maximum-scale=4, viewport-fit=cover',
  )).toBe(
    'width=device-width, viewport-fit=cover, initial-scale=1, minimum-scale=1, maximum-scale=1',
  );
});
