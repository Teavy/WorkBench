import type { CameraState, ContentCategory } from '../types';

export interface Prompts {
  en: string;
  zh: string;
}

export const shortestAzimuthDelta = (source: number, target: number): number => {
  const raw = Math.round(target - source);
  return ((raw + 180) % 360 + 360) % 360 - 180;
};

const signed = (value: number) => `${value > 0 ? '+' : ''}${value}°`;

export const constructAutoBrief = (change: CameraState, category: ContentCategory): Prompts => {
  const yaw = Math.round(change.azimuth);
  const elevation = Math.round(change.elevation);
  const distance = Number(change.distance.toFixed(1));
  const categoryEn = category === 'character' ? 'character/person' : category === 'object' ? 'object/product' : category === 'building' ? 'building/exterior' : 'interior/scene';
  const categoryZh = category === 'character' ? '角色／人物' : category === 'object' ? '物体／产品' : category === 'building' ? '建筑外观' : '室内／场景';
  return {
    en: [
      'AUTO-UNDERSTAND VIEW JOB. This is a task brief, not a finished image-edit prompt.',
      `Selected content type: ${categoryEn}. Treat the supplied image as the starting view, without assuming it is frontal or assigning it an absolute azimuth.`,
      `Requested change relative to the input image: horizontal camera/viewpoint shift ${signed(yaw)}, elevation shift ${signed(elevation)}, distance ${distance}x the input distance (1x = unchanged, below 1x = closer, above 1x = farther).`,
      'Direction convention: a negative horizontal change follows the cube’s minus/left side (for a frontal character it would reveal the character’s own left side); a positive change follows its plus/right side. This defines the relative move, not the final nose direction in an already angled image.',
      'Inspect the image first. Identify the primary subject and useful visual anchors, its pose, head/body/gaze relationship if applicable, and the spatial layout or likely observation center.',
      'Then write a concrete edit prompt for this particular image. Move the virtual viewpoint around the relevant subject/scene; keep the subject, action, head/body relationship, gaze target, room or object structure, lighting, style, and other identity cues consistent unless the new viewpoint requires a visible change. Do not force a nose direction from the cube sign alone.',
      'The requested angles are approximate visual goals, not exact 3D geometry. Synthesize occluded areas plausibly and inspect the output.',
    ].join('\n'),
    zh: [
      '自动理解视角任务说明；这不是已分析原图的最终生图提示词。',
      `内容类型：${categoryZh}。以上传图片作为起始视角，不预设它是正面，也不强行赋予绝对方位角。`,
      `相对原图的目标变化：水平镜位 ${signed(yaw)}，俯仰 ${signed(elevation)}，距离为原图的 ${distance} 倍（1 倍不变；低于 1 倍拉近，高于 1 倍拉远）。`,
      '方向约定：水平负角度沿立方体负号／左侧移动（若原图人物正面，会露出角色自身左侧）；正角度沿正号／右侧移动。这只定义相对变化，不决定已有角度图片的最终鼻尖方向。',
      'Codex 处理任务时先观察原图，识别主体、姿态、头身和视线关系、空间布局及适合的观察中心，再组织针对该图的具体提示词。',
      '镜位变化时尽量保持主体、动作、视线目标、结构、光照和风格；不要只凭立方体的正负号规定鼻尖方向。角度只是近似视觉目标。',
    ].join('\n'),
  };
};

export const constructPrompts = (
  source: CameraState,
  target: CameraState,
  category: ContentCategory,
): Prompts => {
  const sourceAz = Math.round(source.azimuth);
  const targetAz = Math.round(target.azimuth);
  const sourceEl = Math.round(source.elevation);
  const targetEl = Math.round(target.elevation);
  const yawChange = shortestAzimuthDelta(sourceAz, targetAz);
  const heightChange = targetEl - sourceEl;
  const framingEn = target.distance < 0.8 ? 'Close-up' : target.distance > 1.2 ? 'Wide shot' : 'Medium shot';
  const framingZh = target.distance < 0.8 ? '近景' : target.distance > 1.2 ? '远景' : '中景';
  const targetSideEn = targetAz < 0 ? 'LEFT' : 'RIGHT';
  const targetSideZh = targetAz < 0 ? '左' : '右';
  const magnitude = Math.abs(targetAz);

  const calibrationEn = `The user manually calibrated the input view at azimuth ${signed(sourceAz)} and elevation ${signed(sourceEl)}, and the desired final view at azimuth ${signed(targetAz)} and elevation ${signed(targetEl)}. These are visual estimates relative to the subject's front/reference direction, not measured 3D geometry.`;
  const calibrationZh = `用户手动标定原图方位角为 ${signed(sourceAz)}、俯仰角为 ${signed(sourceEl)}；目标方位角为 ${signed(targetAz)}、俯仰角为 ${signed(targetEl)}。这些是相对主体正面／参考方向的视觉估计，不是实测三维数据。`;
  const heightEn = heightChange === 0
    ? 'Keep the original camera height.'
    : `Change camera elevation by ${signed(heightChange)} relative to the input view to reach the target elevation.`;
  const heightZh = heightChange === 0
    ? '保持原图相机高度。'
    : `相对原图将相机俯仰角调整 ${signed(heightChange)}，达到目标高度。`;

  let motionEn: string;
  let motionZh: string;
  let targetEn: string;
  let targetZh: string;
  let preserveEn: string;
  let preserveZh: string;

  if (category === 'interior') {
    motionEn = yawChange === 0
      ? 'Keep the original horizontal camera direction.'
      : `Move the virtual camera viewpoint around the same room/scene toward the target by approximately ${signed(yawChange)} in yaw relative to the input view. Do not rotate the room itself.`;
    motionZh = yawChange === 0
      ? '保持原图的水平相机朝向。'
      : `相对原图，将虚拟相机在同一室内／场景中绕观察中心水平调整约 ${signed(yawChange)}，到达目标视角；不要旋转房间本身。`;
    targetEn = 'Keep the room layout, wall openings, furniture relationships, and architectural perspective coherent. Reveal previously occluded areas only by plausible continuation; do not invent a different room.';
    targetZh = '保持房间布局、墙面开口、家具位置关系和建筑透视连贯。遮挡区域只做合理延续，不要另造一个房间。';
    preserveEn = 'Preserve recognizable furniture, materials, colors, lighting, style, and room identity as closely as possible.';
    preserveZh = '尽量保持可识别的家具、材质、颜色、光照、风格与房间身份。';
  } else {
    motionEn = yawChange === 0
      ? 'Keep the original horizontal view; do not add an unnecessary rotation.'
      : `Change the ${category === 'character' ? 'character orientation' : category === 'building' ? 'viewpoint around the building' : 'viewpoint around the object'} by approximately ${signed(yawChange)} relative to the input view, reaching the target orientation. Do not treat the input as a frontal view unless its calibrated angle is zero.`;
    motionZh = yawChange === 0
      ? '保持原图水平视角，不要额外旋转。'
      : `相对原图${category === 'character' ? '将角色朝向' : category === 'building' ? '将建筑周围的观察视角' : '将物体周围的观察视角'}调整约 ${signed(yawChange)}，到达目标朝向；除非原图标定为零度，否则不要将其当成正面图。`;

    if (category === 'character') {
      targetEn = magnitude <= 2
        ? 'The target is approximately frontal. Keep the eyes aligned with the head and do not force eye contact with the camera.'
        : magnitude >= 170
          ? 'The target shows the back of the character. The face and eyes must not turn back toward the camera.'
          : `The target shows the character's own anatomical ${targetSideEn} cheek/side. The nose should point toward the ${targetSideEn} edge of the frame. Keep the eyes aligned with the head, looking off-camera toward that side rather than turning the pupils back to the viewer.`;
      targetZh = magnitude <= 2
        ? '目标约为正面视角。眼睛跟随头部朝向，不要强制让角色与镜头对视。'
        : magnitude >= 170
          ? '目标为角色背面；脸部和眼睛不要回头看向镜头。'
          : `目标显示角色自身解剖学意义上的${targetSideZh}脸／${targetSideZh}侧。鼻尖应朝画面${targetSideZh}侧；视线跟随头部朝向，望向该侧镜头外，不要让瞳孔单独转回观众。`;
      preserveEn = 'Preserve character identity, facial features, expression, hairstyle, clothing, pose, distinctive details, style, lighting, and background as closely as possible.';
      preserveZh = '尽量保持角色身份、五官、表情、发型、服装、姿势、独特细节、风格、光照和背景。';
    } else {
      const kindEn = category === 'building' ? 'building' : 'object';
      const kindZh = category === 'building' ? '建筑' : '物体';
      targetEn = magnitude <= 2
        ? `The target is approximately the ${kindEn}'s designated front/reference view.`
        : magnitude >= 170
          ? `The target is approximately the ${kindEn}'s rear view.`
          : `The target reveals more of the ${kindEn}'s own ${targetSideEn} side relative to its designated front/reference direction. Do not apply facial anatomy or gaze instructions.`;
      targetZh = magnitude <= 2
        ? `目标约为${kindZh}指定的正面／参考方向。`
        : magnitude >= 170
          ? `目标约为${kindZh}背面。`
          : `目标相对${kindZh}指定的正面／参考方向露出更多自身${targetSideZh}侧；不要套用人脸和视线描述。`;
      preserveEn = `Preserve the ${kindEn}'s recognizable structure, proportions, materials, markings, style, and lighting. Maintain a coherent environment where possible.`;
      preserveZh = `保持${kindZh}可识别的结构、比例、材质、标记、风格和光照，并尽量维持环境连贯。`;
    }
  }

  return {
    en: [
      `Edit the provided image into a new view of the same ${category === 'interior' ? 'interior scene' : category}.`,
      calibrationEn,
      motionEn,
      heightEn,
      targetEn,
      `Framing: ${framingEn}.`,
      preserveEn,
      'Synthesize newly visible areas plausibly. Do not mirror the reference image or add unrelated objects or text.',
      'Angles are visual targets, not guarantees of exact 3D geometry.',
    ].join('\n'),
    zh: [
      `将参考图编辑为同一${category === 'character' ? '角色' : category === 'object' ? '物体' : category === 'building' ? '建筑' : '室内场景'}的新视角。`,
      calibrationZh,
      motionZh,
      heightZh,
      targetZh,
      `景别：${framingZh}。`,
      preserveZh,
      '合理补全新露出的区域；不要镜像参考图，也不要加入无关物体或文字。',
      '角度是视觉目标，并非精确三维几何保证。',
    ].join('\n'),
  };
};
