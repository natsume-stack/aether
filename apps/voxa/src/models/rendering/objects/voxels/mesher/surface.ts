import { ArgObject, compileCwise } from '../../../utils/cwise';
import {
  AOSurfaceUint16,
  AO_SHIFT,
  BL_AO_SHIFT,
  BR_AO_SHIFT,
  FLIP_BIT,
  OPAQUE_BIT,
  TR_AO_SHIFT,
} from './def';

function arg(name: string, lv: boolean, rv: boolean, count: number) {
  return { name: name, lvalue: lv, rvalue: rv, count: count };
}

// Compile surface stencil operator
/**
 * 计算AO以及所需要渲染的面的函数
 * TODO 复杂度超标，需要看怎么拆
 */
export const surfaceStencil = (function () {
  const empty_proc = { args: [], thisVars: [], localVars: [], body: '' };

  /**
   * 外层函数的参数
   */
  const cwise_args: (string | ArgObject)[] = [
    'scalar', // 传入内部函数的真正函数体
    'array', // ao0 计算区域的数据结构
    'array', // ao1 计算区域的数据结构
    'array', // ao2 计算区域的数据结构
    'array', // array 待计算的体素数据
  ];

  /**
   * cwise 的隐藏机制，用于构造内部函数
   */
  const cwise_arg_names = [
    arg('_func', false, true, 3),
    arg('_o0', true, false, 1),
    arg('_o1', true, false, 1),
    arg('_o2', true, false, 1),
  ];

  // 生成 2 层函数的参数，一共会有3个函数，对应上面的 _o0 ~ _o2
  // 对应的参数则对应 [z, y, x] [x, z, y] [y, x, z]
  const cwise_body: string[] = [];
  for (let d = 0; d < 3; ++d) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const expr: string[] = [];
    for (let dz = 0; dz < 2; ++dz)
      for (let dy = 0; dy <= 2; ++dy)
        for (let dx = 0; dx <= 2; ++dx) {
          let x = [dx, dy, dz];
          expr.push(['_a', x[v], x[u], x[d]].join(''));
        }
    cwise_body.push(['_o', d, '=_func(', expr.join(','), ')'].join(''));
  }

  let cwise_body_str = cwise_body.join('\n');
  for (let dx = -1; dx <= 1; ++dx)
    for (let dy = -1; dy <= 1; ++dy)
      for (let dz = -1; dz <= 1; ++dz) {
        if (dx === 1 && dy === 1 && dz === 1) {
          continue;
        }
        if (!(dx === -1 && dy === -1 && dz === -1)) {
          cwise_args.push({ offset: [dx + 1, dy + 1, dz + 1], array: 3 });
        }
        let carg_name = ['_a', dx + 1, dy + 1, dz + 1].join('');
        cwise_arg_names.push(
          arg(
            carg_name,
            false,
            true,
            cwise_body_str.split(carg_name).length - 1,
          ),
        );
      }
  return compileCwise({
    args: cwise_args,
    pre: empty_proc,
    body: {
      args: cwise_arg_names,
      body: cwise_body_str,
      thisVars: [],
      localVars: [],
    },
    post: empty_proc,
    funcName: 'calcAO',
  }).bind(undefined, generateSurface);
})();

/**
 *  Generates a surface with ambient occlusion type
 *  真正在 Stencil 中被执行的函数，在X、Y、Z每个方向上会执行一次
 * @param voxelBackTopL Voxel的数据，16bit
 * @returns vertex 面体素+AO数据，16+8+1 = 25bit，[FLIP(1bit), AO Type(8bit), VOXEL(16bit)]
 */
function generateSurface(
  voxelBackTopL: number,
  voxelBackTop: number,
  voxelBackTopR: number,
  voxelBackLeft: number,
  voxelBack: number,
  voxelBackRight: number,
  voxelBackBottomL: number,
  voxelBackBottom: number,
  voxelBackBottomR: number,
  voxelFrontTopL: number,
  voxelFrontTop: number,
  voxelFrontTopR: number,
  voxelFrontLeft: number,
  voxelFront: number,
  voxelFrontRight: number,
  voxelFrontBottomL: number,
  voxelFrontBottom: number,
  voxelFrontBottomR: number,
): AOSurfaceUint16 | undefined {
  if (!voxelBack === !voxelFront) {
    return;
  }

  const isBackTransparent = !(voxelBack & OPAQUE_BIT),
    isFrontTransparent = !(voxelFront & OPAQUE_BIT);

  // 判断采用哪一侧的Voxel来做AO，两侧均为不透明、不存在或透明的情况下返回 undefined
  // 按不透明 > 透明 > 无Voxel 的顺序选择
  if (
    voxelFront &&
    (!voxelBack || (isBackTransparent && !isFrontTransparent))
  ) {
    return (
      voxelFront |
      FLIP_BIT |
      facetAO(
        voxelBackTopL,
        voxelBackTop,
        voxelBackTopR,
        voxelBackLeft,
        voxelBackRight,
        voxelBackBottomL,
        voxelBackBottom,
        voxelBackBottomR,
      )
    );
  } else if (
    voxelBack &&
    (!voxelFront || (isFrontTransparent && !isBackTransparent))
  ) {
    return (
      voxelBack |
      facetAO(
        voxelFrontTopL,
        voxelFrontTop,
        voxelFrontTopR,
        voxelFrontLeft,
        voxelFrontRight,
        voxelFrontBottomL,
        voxelFrontBottom,
        voxelFrontBottomR,
      )
    );
  }
}

/**
 * 参考大佬的文章，但其中代表 AO 结果的数字有所不同，idk why
 * https://0fps.net/2013/07/03/ambient-occlusion-for-minecraft-like-worlds/
 * @param side1
 * @param side2
 * @param corner
 * @returns 对应顶点的 ao-style， 可能值为 1｜2｜3， 依次代表 2面遮挡｜1面遮挡｜无遮挡
 */
function vertexAO(side1: number, side2: number, corner: number) {
  if (side1 && side2) {
    return 1;
  }
  return 3 - (side1 + side2 + corner);
}

/**
 * Calculates the ambient occlusion bit mask for a facet
 * @param voxelTopLeft 16bit, []
 * @param voxelTop
 * @param voxelTopRight
 * @param voxelLeft
 * @param voxelRight
 * @param voxelBottomLeft
 * @param voxelBottom
 * @param voxelBottomRight
 * @returns 代表面上四个点的 AO Style，腾出低16位为空，只占用高8位，每个点占 2bit [ BottomLeft BottomRight TopRight TopLeft ]
 **/
function facetAO(
  voxelTopLeft: number,
  voxelTop: number,
  voxelTopRight: number,
  voxelLeft: number,
  voxelRight: number,
  voxelBottomLeft: number,
  voxelBottom: number,
  voxelBottomRight: number,
) {
  const existTopLeft = voxelTopLeft & OPAQUE_BIT ? 1 : 0,
    existTop = voxelTop & OPAQUE_BIT ? 1 : 0,
    existTopRight = voxelTopRight & OPAQUE_BIT ? 1 : 0,
    existLeft = voxelLeft & OPAQUE_BIT ? 1 : 0,
    existRight = voxelRight & OPAQUE_BIT ? 1 : 0,
    existBottomLeft = voxelBottomLeft & OPAQUE_BIT ? 1 : 0,
    existBottom = voxelBottom & OPAQUE_BIT ? 1 : 0,
    existBottomRight = voxelBottomRight & OPAQUE_BIT ? 1 : 0;
  return (
    (vertexAO(existLeft, existTop, existTopLeft) << AO_SHIFT) +
    (vertexAO(existTop, existRight, existTopRight) << TR_AO_SHIFT) +
    (vertexAO(existRight, existBottom, existBottomRight) << BR_AO_SHIFT) +
    (vertexAO(existBottom, existLeft, existBottomLeft) << BL_AO_SHIFT)
  );
}
