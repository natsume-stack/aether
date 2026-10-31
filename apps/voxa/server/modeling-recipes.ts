export type RecipeCommand = { kind: string; args: Record<string, unknown> };
export type RecipeBatch = { stage: 'S1' | 'S2' | 'S3' | 'S4' | 'S5'; commands: RecipeCommand[]; message: string };
export type RecipeState = { kind: 'bat'; next: number; shape: [number, number, number] };

export function detectRecipe(prompt: string): 'bat' | undefined {
  return /(蝙蝠|bat)/i.test(String(prompt || '')) ? 'bat' : undefined;
}

function scaled(value: number, size: number) {
  return Math.max(0, Math.min(size - 1, Math.round((value / 16) * size)));
}

function radius(value: number, size: number) {
  return Math.max(1, Math.round((value / 16) * size));
}

/**
 * A deterministic half-build + mirror bat. One part, so the editor context and
 * quality brief always see the whole model. Low-reasoning models get a solid
 * baseline without spending reasoning tokens on voxel math.
 */
export function batRecipe(shape: [number, number, number]): RecipeBatch[] {
  const [sx, sy, sz] = shape;
  const x = (value: number) => scaled(value, sx);
  const y = (value: number) => scaled(value, sy);
  const z = (value: number) => scaled(value, sz);
  const centerX = Math.floor(sx / 2);
  const leftCenter = Math.floor((sx - 1) / 2);
  const rightCenter = sx - 1 - leftCenter;
  const rx = (value: number) => radius(value, sx);
  const ry = (value: number) => radius(value, sy);
  const rz = (value: number) => radius(value, sz);

  const palette = [
    { alias: '$fur', rgb: [46, 33, 64] },
    { alias: '$wing', rgb: [74, 50, 104] },
    { alias: '$belly', rgb: [116, 86, 148] },
    { alias: '$eye', rgb: [255, 70, 70], emissive: 220 },
    { alias: '$fang', rgb: [242, 233, 216] },
    { alias: '$inner', rgb: [176, 106, 138] },
  ].map((color) => ({ kind: 'palette_add', args: color }));

  const bodyY = y(6);
  const bodyZ = z(8);
  const headY = y(10);
  const headZ = z(8);
  const wingZ = z(8);
  const wingBottom = y(5);
  const wingTop = y(9);
  const earBottom = y(12);
  const earTop = y(14);
  const earZ = z(7);

  const blockout: RecipeCommand[] = [
    { kind: 'part_create', args: { alias: '$bat', name: 'Bat' } },
    // Body/head: build the left half, then mirror the whole part.
    { kind: 'ellipsoid', args: { center: [centerX, bodyY, bodyZ], radii: [rx(2), ry(2), rz(2)], colorId: '$fur' } },
    { kind: 'erase_box', args: { from: [centerX, y(4), z(6)], to: [sx - 1, y(8), z(10)] } },
    { kind: 'ellipsoid', args: { center: [centerX, headY, headZ], radii: [rx(3), ry(3), rz(2)], colorId: '$fur' } },
    { kind: 'erase_box', args: { from: [centerX, y(7), z(6)], to: [sx - 1, y(13), z(10)] } },
    // Left ear.
    { kind: 'fill_box', args: { from: [x(4), earBottom, earZ], to: [x(5), earTop, z(8)], colorId: '$fur' } },
    // Left wing membrane with scalloped bottom and finger ridges.
    { kind: 'fill_box', args: { from: [x(0), wingBottom, wingZ], to: [x(5), wingTop, wingZ], colorId: '$wing' } },
    { kind: 'erase_box', args: { from: [x(0), wingBottom, wingZ], to: [x(1), wingBottom, wingZ] } },
    { kind: 'erase_box', args: { from: [x(3), wingBottom, wingZ], to: [x(4), wingBottom, wingZ] } },
    { kind: 'paint_path', args: { points: [[x(1), y(6), wingZ], [x(1), y(7), wingZ], [x(1), y(8), wingZ]], colorId: '$fur' } },
    { kind: 'paint_path', args: { points: [[x(3), y(6), wingZ], [x(3), y(7), wingZ], [x(3), y(8), wingZ]], colorId: '$fur' } },
    { kind: 'paint_path', args: { points: [[x(5), y(6), wingZ], [x(5), y(7), wingZ], [x(5), y(8), wingZ]], colorId: '$fur' } },
    // Left tail half, completed by the mirror.
    { kind: 'fill_box', args: { from: [leftCenter, y(3), z(8)], to: [leftCenter, y(4), z(8)], colorId: '$wing' } },
    { kind: 'paint', args: { at: [leftCenter, y(2), z(8)], colorId: '$wing' } },
    // Left-side details; the final mirror duplicates them exactly.
    { kind: 'paint', args: { at: [x(6), headY, z(9)], colorId: '$eye' } },
    { kind: 'paint', args: { at: [leftCenter, y(9), z(9)], colorId: '$fur' } },
    { kind: 'paint', args: { at: [x(7), y(8), z(9)], colorId: '$fang' } },
    { kind: 'paint', args: { at: [leftCenter, y(5), z(9)], colorId: '$belly' } },
    { kind: 'paint', args: { at: [leftCenter, y(6), z(9)], colorId: '$belly' } },
    { kind: 'paint', args: { at: [x(5), y(13), z(8)], colorId: '$inner' } },
    { kind: 'mirror', args: { axis: 'x' } },
  ];

  const detail: RecipeCommand[] = [
    // These are explicitly paired because they happen after the mirror.
    { kind: 'paint', args: { at: [x(6), y(11), z(9)], colorId: '$fang' } },
    { kind: 'paint', args: { at: [sx - 1 - x(6), y(11), z(9)], colorId: '$fang' } },
    { kind: 'paint', args: { at: [leftCenter, y(4), z(9)], colorId: '$belly' } },
    { kind: 'paint', args: { at: [rightCenter, y(4), z(9)], colorId: '$belly' } },
    { kind: 'paint', args: { at: [x(0), y(5), wingZ], colorId: '$fur' } },
    { kind: 'paint', args: { at: [sx - 1 - x(0), y(5), wingZ], colorId: '$fur' } },
  ];

  return [
    { stage: 'S1', commands: [...palette, ...blockout], message: '蝙蝠基础配方：半边部件、翼膜、耳与尾部已构建并镜像' },
    { stage: 'S2', commands: detail, message: '补上眼部高光、腹部与翼尖细节，基础蝙蝠完成' },
  ];
}

export function recipeDone(state: RecipeState) {
  return state.next >= batRecipe(state.shape).length;
}
