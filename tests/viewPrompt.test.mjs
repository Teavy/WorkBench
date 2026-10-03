import test from 'node:test';
import assert from 'node:assert/strict';
import { constructAutoBrief, constructPrompts, shortestAzimuthDelta } from '../services/viewPrompt.ts';

const view = (azimuth, elevation = 0) => ({ azimuth, elevation, distance: 1 });

test('calibrated input and target yield relative rotation but target-facing gaze', () => {
  const { en, zh } = constructPrompts(view(30, 10), view(-40, 22), 'character');
  assert.match(en, /input view at azimuth \+30° and elevation \+10°/);
  assert.match(en, /desired final view at azimuth -40° and elevation \+22°/);
  assert.match(en, /approximately -70° relative to the input view/);
  assert.match(en, /anatomical LEFT cheek/);
  assert.match(en, /nose should point toward the LEFT edge/);
  assert.match(en, /Change camera elevation by \+12°/);
  assert.match(zh, /调整约 -70°/);
});

test('relative rotation need not match target nose direction', () => {
  const { en } = constructPrompts(view(60), view(20), 'character');
  assert.match(en, /approximately -40° relative/);
  assert.match(en, /anatomical RIGHT cheek/);
  assert.match(en, /nose should point toward the RIGHT edge/);
});

test('front and rear character views avoid side gaze instructions', () => {
  const front = constructPrompts(view(40), view(0), 'character').en;
  const rear = constructPrompts(view(0), view(180), 'character').en;
  assert.match(front, /approximately frontal/);
  assert.doesNotMatch(front, /nose should point/);
  assert.match(rear, /back of the character/);
  assert.doesNotMatch(rear, /nose should point/);
});

test('object and building prompts omit anatomical and gaze language', () => {
  for (const category of ['object', 'building']) {
    const { en } = constructPrompts(view(0), view(-45), category);
    assert.match(en, /own LEFT side/);
    assert.doesNotMatch(en, /anatomical|nose|eyes aligned|pupils/);
  }
});

test('interior moves camera rather than rotating room or character', () => {
  const { en, zh } = constructPrompts(view(-20), view(35, 15), 'interior');
  assert.match(en, /virtual camera viewpoint/);
  assert.match(en, /approximately \+55° in yaw/);
  assert.match(en, /Do not rotate the room itself/);
  assert.doesNotMatch(en, /nose|cheek|anatomical/);
  assert.match(zh, /不要旋转房间本身/);
});

test('shortest azimuth delta crosses the back seam', () => {
  assert.equal(shortestAzimuthDelta(170, -170), 20);
  assert.equal(shortestAzimuthDelta(-170, 170), -20);
});

test('auto brief treats uploaded image as reference, not a frontal pose', () => {
  const { en, zh } = constructAutoBrief({ azimuth: 45, elevation: -10, distance: 0.7 }, 'character');
  assert.match(en, /task brief, not a finished image-edit prompt/);
  assert.match(en, /without assuming it is frontal/);
  assert.match(en, /horizontal camera\/viewpoint shift \+45°/);
  assert.match(en, /elevation shift -10°/);
  assert.match(en, /below 1x = closer/);
  assert.match(en, /head\/body\/gaze relationship/);
  assert.doesNotMatch(en, /nose must point toward/);
  assert.match(zh, /这不是已分析原图的最终生图提示词/);
});

test('auto brief keeps scene category without manual source calibration', () => {
  const { en } = constructAutoBrief(view(-30), 'interior');
  assert.match(en, /Selected content type: interior\/scene/);
  assert.match(en, /likely observation center/);
  assert.doesNotMatch(en, /calibrated the input view at azimuth/);
});
