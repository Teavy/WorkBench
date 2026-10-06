export const defaults = Object.freeze({ color: '#00FF00', similarity: 0.27, blend: 0.08, fps: 20, size: 'original', width: 512, height: 512, squareMode: 'crop', cropScale: 1, cropX: 0.5, cropY: 0.5, foregroundZoom: 1, foregroundX: 0, foregroundY: 0, startFrame: 1, endFrame: null, sourceFps: 30 });

export function parseConfig(value) {
  const config = { ...defaults, ...value };
  if (!/^#[0-9a-fA-F]{6}$/.test(config.color)) throw new Error('Key color must be #RRGGBB.');
  for (const [key, min, max] of [['similarity', 0.01, 1], ['blend', 0, 1], ['fps', 1, 60], ['cropScale', 0.5, 1], ['cropX', 0, 1], ['cropY', 0, 1], ['foregroundZoom', 0.5, 2], ['foregroundX', -1, 1], ['foregroundY', -1, 1], ['sourceFps', 1, 120]]) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < min || config[key] > max) {
      throw new Error(`${key} must be between ${min} and ${max}.`);
    }
  }
  if (!['original', '256', '512', '1024', 'custom'].includes(String(config.size))) throw new Error('Unsupported output size.');
  if (config.size === 'custom' && (!Number.isInteger(config.width) || !Number.isInteger(config.height) || config.width < 16 || config.width > 4096 || config.height < 16 || config.height > 4096)) throw new Error('Custom dimensions must be integers from 16 to 4096.');
  if (!Number.isInteger(config.startFrame) || config.startFrame < 1) throw new Error('Start frame must be a positive integer.');
  if (config.endFrame !== null && (!Number.isInteger(config.endFrame) || config.endFrame < config.startFrame)) throw new Error('End frame cannot precede the start frame.');
  if (!['crop', 'pad'].includes(config.squareMode)) throw new Error('Unsupported frame fitting mode.');
  return config;
}

export function outputDimensions(config, source) {
  if (config.size === 'original') return { width: source.width, height: source.height };
  if (config.size === 'custom') return { width: config.width, height: config.height };
  const side = Number(config.size);
  return { width: side, height: side };
}

export function cropGeometry(config, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) throw new Error('Invalid video dimensions.');
  const target = outputDimensions(config, { width, height });
  const ratio = target.width / target.height;
  const baseWidth = Math.min(width, height * ratio);
  const baseHeight = baseWidth / ratio;
  const cropWidth = Math.max(2, Math.floor(baseWidth * config.cropScale / 2) * 2);
  const cropHeight = Math.max(2, Math.floor(baseHeight * config.cropScale / 2) * 2);
  return {
    width: cropWidth,
    height: cropHeight,
    x: Math.round((width - cropWidth) * config.cropX),
    y: Math.round((height - cropHeight) * config.cropY),
  };
}

export function filterFor(config, dimensions, preview = false) {
  const color = `0x${config.color.slice(1)}`;
  const filters = [];
  if (!preview && (config.startFrame > 1 || config.endFrame !== null)) {
    // The timeline indexes time using sourceFps, which may differ from the
    // encoded video rate. Trim by that same time to keep preview and export aligned.
    const start = (config.startFrame - 1) / config.sourceFps;
    const end = config.endFrame === null ? '' : `:end=${config.endFrame / config.sourceFps}`;
    filters.push('setpts=PTS-STARTPTS', `trim=start=${start}${end}`, 'setpts=PTS-STARTPTS');
  }
  filters.push('format=rgba', `colorkey=${color}:${config.similarity}:${config.blend}`);
  if (!preview) filters.push(`fps=${config.fps}`);
  if (config.size !== 'original') {
    const target = outputDimensions(config, dimensions);
    if (config.squareMode === 'crop') {
      const crop = cropGeometry(config, dimensions.width, dimensions.height);
      filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`, `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${target.width}:${target.height}:(iw-ow)/2:(ih-oh)/2`);
    } else {
      filters.push(`scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
    }
  }
  if (config.foregroundZoom !== 1 || config.foregroundX !== 0 || config.foregroundY !== 0) {
    const target = outputDimensions(config, dimensions);
    const scaledWidth = Math.max(2, Math.round(target.width * config.foregroundZoom));
    const scaledHeight = Math.max(2, Math.round(target.height * config.foregroundZoom));
    const canvasWidth = Math.max(target.width, scaledWidth) + target.width * 2;
    const canvasHeight = Math.max(target.height, scaledHeight) + target.height * 2;
    const offsetX = Math.round((canvasWidth - target.width) / 2 - config.foregroundX * target.width);
    const offsetY = Math.round((canvasHeight - target.height) / 2 - config.foregroundY * target.height);
    filters.push(`scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${canvasWidth}:${canvasHeight}:(ow-iw)/2:(oh-ih)/2:color=black@0`, `crop=${target.width}:${target.height}:${offsetX}:${offsetY}`);
  }
  filters.push('format=rgba');
  return filters.join(',');
}
