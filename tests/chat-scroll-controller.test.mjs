import assert from 'node:assert/strict';
import test from 'node:test';
import { createScrollControllerFixture } from './helpers/scrollControllerFixture.mjs';

for (const height of [192, 181]) {
  for (const scrollend of [false, true]) {
    test(`follows accepted ${height}->${height + 3}->179 layout clamp (scrollend=${scrollend})`, async () => {
      const fixture = await createScrollControllerFixture({ height });
      try {
        assert.equal(fixture.container.scrollTop, 8061 - height);
        fixture.resize(height + 3);
        assert.equal(fixture.container.scrollTop, 8061 - height - 3);
        fixture.emit('scroll');
        if (scrollend) fixture.emit('scrollend');
        assert.equal(fixture.pendingFrames(), 1);
        fixture.resize(179);
        fixture.frame();
        assert.equal(fixture.controller.snapshot().following, true);
        assert.equal(fixture.controller.snapshot().anchor, null);
        assert.equal(fixture.container.scrollTop, 7882);
        fixture.deliverResize();
        fixture.frame();
        assert.equal(fixture.container.scrollTop, 7882);
      } finally { fixture.cleanup(); }
    });
  }
}

test('independent scrolling during a geometry change still leaves following', async () => {
  const fixture = await createScrollControllerFixture();
  try {
    fixture.resize(195);
    fixture.container.scrollTop -= 100;
    const requested = fixture.container.scrollTop;
    fixture.emit('scroll');
    assert.equal(fixture.controller.snapshot().following, false);
    assert.equal(fixture.pendingFrames(), 0);
    assert.equal(fixture.container.scrollTop, requested);
  } finally { fixture.cleanup(); }
});

test('motion after accepted layout is detected before its delayed scroll event', async () => {
  const fixture = await createScrollControllerFixture();
  try {
    fixture.resize(195);
    fixture.emit('scroll');
    fixture.resize(179);
    fixture.container.scrollTop -= 100;
    const requested = fixture.container.scrollTop;
    fixture.frame();
    assert.equal(fixture.controller.snapshot().following, false);
    assert.equal(fixture.container.scrollTop, requested);
    fixture.emit('scroll');
    assert.equal(fixture.container.scrollTop, requested);
  } finally { fixture.cleanup(); }
});

test('wheel intent cancels queued following and preserves the new reading position', async () => {
  const fixture = await createScrollControllerFixture();
  try {
    fixture.resize(195);
    fixture.emit('scroll');
    fixture.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: -100 });
    fixture.container.scrollTop -= 100;
    fixture.emit('scroll');
    fixture.emit('scrollend');
    assert.equal(fixture.controller.snapshot().following, false);
    assert.equal(fixture.pendingFrames(), 0);
  } finally { fixture.cleanup(); }
});

test('accepted layout keeps the historical anchor and its bottom-relative correction', async () => {
  const anchor = { kind: 'element', messageId: 'history', index: 0, fraction: 0, bottomGap: 12 };
  const fixture = await createScrollControllerFixture({
    initial: { following: false, anchor, scrollTop: 600 },
  });
  try {
    fixture.resize(195);
    fixture.emit('scroll');
    fixture.resize(179);
    fixture.frame();
    assert.equal(fixture.controller.snapshot().following, false);
    assert.equal(fixture.controller.snapshot().anchor, anchor);
    assert.equal(fixture.container.scrollTop, 613);
  } finally { fixture.cleanup(); }
});

test('suspended and disposed controllers ignore layout events', async () => {
  const fixture = await createScrollControllerFixture();
  try {
    fixture.controller.suspend();
    fixture.resize(195);
    fixture.emit('scroll');
    fixture.deliverResize();
    assert.equal(fixture.pendingFrames(), 0);
    fixture.controller.dispose();
    fixture.resize(179);
    fixture.emit('scroll');
    fixture.deliverResize();
    assert.equal(fixture.pendingFrames(), 0);
  } finally { fixture.cleanup(); }
});
