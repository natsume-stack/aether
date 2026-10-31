const key = (x, y, z) => `${x},${y},${z}`;
const inside = (p, region) => p.every((n, axis) => n >= region.min[axis] && n <= region.max[axis]);
const refuse = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

/** Compile bounded edits of existing content into supported terrainApply boxes.
 * Protected cells and unchanged cells never appear in the result.
 */
export function compileLocalTerrain(
  { region, kind, block, sourceBlock, preserve = [], path, width = 3, maxStepHeight = 1 },
  snapshot,
) {
  if (
    !region?.min ||
    !region?.max ||
    region.min.length !== 3 ||
    region.max.length !== 3 ||
    ![...region.min, ...region.max].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    region.min.some((n, axis) => n > region.max[axis])
  )
    refuse('INVALID_REGION', 'Supply an inclusive, ordered integer region');
  if (!['fill', 'replace', 'surface', 'road'].includes(kind))
    refuse('INVALID_OPERATOR', 'Supported operators: fill, replace, surface, road');
  if (!Number.isInteger(block) || block < 0 || block > 16383)
    refuse('INVALID_BLOCK', 'Supply a block type id from map_blocks');
  if (
    kind === 'replace' &&
    (!Number.isInteger(sourceBlock) || sourceBlock < 0 || sourceBlock > 16383)
  )
    refuse('INVALID_SOURCE_BLOCK', 'replace requires sourceBlock');
  if (!Array.isArray(preserve) || preserve.length > 64)
    refuse('INVALID_PRESERVE_REGION', 'At most 64 protected regions');
  for (const r of preserve) {
    if (
      !r?.min ||
      !r.max ||
      r.min.length !== 3 ||
      r.max.length !== 3 ||
      ![...r.min, ...r.max].every(Number.isSafeInteger) ||
      r.min.some((n, axis) => n > r.max[axis])
    )
      refuse('INVALID_PRESERVE_REGION', 'Protected regions must have ordered integer corners');
  }
  const volume = region.min.reduce((n, v, axis) => n * (region.max[axis] - v + 1), 1);
  if (
    !Number.isSafeInteger(volume) ||
    volume > 200_000 ||
    snapshot.truncated ||
    snapshot.cells?.length !== volume ||
    !snapshot.revision
  )
    refuse(
      'INCOMPLETE_SOURCE',
      'Read the complete selected region (maximum 200000 cells) before compiling',
    );
  const cells = new Map();
  for (const c of snapshot.cells) {
    if (
      !inside([c.x, c.y, c.z], region) ||
      ![c.x, c.y, c.z, c.b].every(Number.isSafeInteger) ||
      c.b < 0 ||
      c.b > 65535
    )
      refuse('INVALID_SOURCE', 'Snapshot contains invalid cells');
    cells.set(key(c.x, c.y, c.z), c);
  }
  if (cells.size !== volume)
    refuse('INCOMPLETE_SOURCE', 'Snapshot contains duplicate or missing cells');
  const top = new Map();
  if (kind === 'surface' || kind === 'road')
    for (const c of cells.values()) {
      if ((c.b & 16383) !== 0)
        top.set(`${c.x},${c.z}`, Math.max(top.get(`${c.x},${c.z}`) ?? -1, c.y));
    }
  let road;
  if (kind === 'road') {
    if (block === 0) refuse('INVALID_ROAD_MATERIAL', 'A road must not erase its existing ground');
    if (
      !Array.isArray(path) ||
      path.length < 2 ||
      path.length > 64 ||
      path.some(
        (p) =>
          !Array.isArray(p) ||
          p.length !== 2 ||
          !p.every(Number.isSafeInteger) ||
          p[0] < region.min[0] ||
          p[0] > region.max[0] ||
          p[1] < region.min[2] ||
          p[1] > region.max[2],
      )
    ) {
      refuse('INVALID_ROAD_PATH', 'Supply 2–64 integer [x,z] points inside the selected region');
    }
    if (
      !Number.isInteger(width) ||
      width < 1 ||
      width > 15 ||
      width % 2 !== 1 ||
      !Number.isInteger(maxStepHeight) ||
      maxStepHeight < 0 ||
      maxStepHeight > 1
    ) {
      refuse(
        'INVALID_ROAD_PROFILE',
        'Road width must be odd, 1–15; maximum adjacent height difference is 0 or 1',
      );
    }
    const radius = (width - 1) / 2;
    // Refuse clipping: an apparently complete road must not silently lose its edge.
    if (
      path.some(
        ([x, z]) =>
          x - radius < region.min[0] ||
          x + radius > region.max[0] ||
          z - radius < region.min[2] ||
          z + radius > region.max[2],
      )
    ) {
      refuse('ROAD_OUTSIDE_REGION', 'Include the full road width inside the selected region');
    }
    road = new Set();
    // Rasterise each segment then dilate by a square brush. This produces a
    // continuous voxel path, including width-one diagonals and sharp corners.
    for (let i = 1; i < path.length; i++) {
      const [x0, z0] = path[i - 1],
        [x1, z1] = path[i];
      const count = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
      const centers = [];
      for (let t = 0; t <= count; t++) {
        const x = count ? Math.round(x0 + ((x1 - x0) * t) / count) : x0;
        const z = count ? Math.round(z0 + ((z1 - z0) * t) / count) : z0;
        const previous = centers.at(-1);
        if (previous && previous[0] !== x && previous[1] !== z) centers.push([x, previous[1]]);
        centers.push([x, z]);
      }
      for (const [cx, cz] of centers)
        for (let x = cx - radius; x <= cx + radius; x++)
          for (let z = cz - radius; z <= cz + radius; z++) road.add(`${x},${z}`);
    }
    for (const column of road) {
      if (!top.has(column))
        refuse(
          'ROAD_UNSUPPORTED',
          'Road crosses a column with no solid surface in the complete selected snapshot',
        );
      const [x, z] = column.split(',').map(Number);
      for (const adjacent of [`${x + 1},${z}`, `${x},${z + 1}`]) {
        if (road.has(adjacent) && Math.abs(top.get(column) - top.get(adjacent)) > maxStepHeight) {
          refuse(
            'ROAD_TOO_STEEP',
            'Existing surface exceeds the requested step height; choose another route or explicitly grade terrain first',
          );
        }
      }
    }
  }
  const selected = new Set();
  for (const c of cells.values()) {
    if (c.b === block || preserve.some((r) => inside([c.x, c.y, c.z], r))) continue;
    if (kind === 'replace' && (c.b & 16383) !== sourceBlock) continue;
    if ((kind === 'surface' || kind === 'road') && top.get(`${c.x},${c.z}`) !== c.y) continue;
    if (kind === 'road' && !road.has(`${c.x},${c.z}`)) continue;
    selected.add(key(c.x, c.y, c.z));
  }
  const changed = selected.size;
  const steps = [];
  // Greedy exact boxes. Expand only through selected cells; never cross a hole.
  for (let x = region.min[0]; x <= region.max[0]; x++) {
    for (let y = region.min[1]; y <= region.max[1]; y++) {
      for (let z = region.min[2]; z <= region.max[2]; z++) {
        if (!selected.has(key(x, y, z))) continue;
        let z1 = z,
          y1 = y,
          x1 = x;
        while (z1 < region.max[2] && selected.has(key(x, y, z1 + 1))) z1++;
        const row = (xx, yy) => {
          for (let zz = z; zz <= z1; zz++) if (!selected.has(key(xx, yy, zz))) return false;
          return true;
        };
        while (y1 < region.max[1] && row(x, y1 + 1)) y1++;
        const plane = (xx) => {
          for (let yy = y; yy <= y1; yy++) if (!row(xx, yy)) return false;
          return true;
        };
        while (x1 < region.max[0] && plane(x1 + 1)) x1++;
        for (let xx = x; xx <= x1; xx++)
          for (let yy = y; yy <= y1; yy++)
            for (let zz = z; zz <= z1; zz++) selected.delete(key(xx, yy, zz));
        steps.push({
          tool: 'terrainApply',
          args: { region: { min: [x, y, z], max: [x1, y1, z1] }, block },
        });
        if (steps.length > 64)
          refuse('PROPOSAL_TOO_FRAGMENTED', 'More than 64 exact boxes; choose a smaller region');
      }
    }
  }
  return { expectedRevision: snapshot.revision, steps, changed, operator: kind, region };
}

export function buildLocalTerrainTools(client, config) {
  const corner = {
    type: 'array',
    items: { type: 'integer', minimum: 0 },
    minItems: 3,
    maxItems: 3,
  };
  const region = {
    type: 'object',
    properties: { min: corner, max: corner },
    required: ['min', 'max'],
    additionalProperties: false,
  };
  return [
    {
      name: 'map_propose_local_terrain',
      description:
        'Read existing terrain and propose fill, replace, surface, or a continuous road along [x,z] waypoints on existing top surfaces. Road refuses missing ground, clipping and excessive steps; does not grade terrain or clear headroom. Preserves excluded regions (which may interrupt a road). Exact boxes only; never applies or saves.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          region,
          kind: { type: 'string', enum: ['fill', 'replace', 'surface', 'road'] },
          block: { type: 'integer', minimum: 0, maximum: 16383 },
          sourceBlock: { type: 'integer', minimum: 0, maximum: 16383 },
          preserve: { type: 'array', items: region, maxItems: 64 },
          path: {
            type: 'array',
            minItems: 2,
            maxItems: 64,
            items: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: { type: 'integer', minimum: 0 },
            },
            description: 'Road centerline [x,z] waypoints; required for road',
          },
          width: { type: 'integer', enum: [1, 3, 5, 7, 9, 11, 13, 15], default: 3 },
          maxStepHeight: { type: 'integer', minimum: 0, maximum: 1, default: 1 },
        },
        required: ['region', 'kind', 'block'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async ({ projectId, ...intent }) => {
        const snapshot = await client.mapAuthoring(
          'terrainRead',
          { region: intent.region, limit: 200_000 },
          { projectId },
        );
        const plan = compileLocalTerrain(intent, snapshot);
        if (!plan.steps.length)
          return {
            summary: 'Selected content already matches; no proposal needed',
            data: { changed: 0 },
          };
        if (intent.kind === 'road') {
          const material = await client.mapAuthoring('getBlock', { key: intent.block }, { projectId });
          if (material.success !== true || material.block?.id !== intent.block || !material.block.valid
            || !material.block.solid || !material.block.collision || material.block.fluid) {
            refuse('INVALID_ROAD_MATERIAL', 'Choose a valid solid, collidable, non-fluid road block from this project');
          }
        }
        const proposal = await client.mapAuthoring(
          'authoringPropose',
          { steps: plan.steps, expectedRevision: plan.expectedRevision },
          { projectId },
        );
        return {
          summary: `${intent.kind}: ${plan.changed} cells in ${plan.steps.length} boxes`,
          data: {
            ...proposal,
            changed: plan.changed,
            operator: plan.operator,
            region: plan.region,
          },
        };
      },
    },
  ];
}
