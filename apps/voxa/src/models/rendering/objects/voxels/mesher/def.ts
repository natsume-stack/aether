/**
 * 猜测是用来判断是否透明
 * 十进制：32768
 * 二进制: 1000000000000000
 * 外部传入数据时，如果非0，需要先进行 V | OPAQUE_BIT计算。
 * mesher内部使用 V & OPAQUE_BIT 判断是否为空。
 */
export const OPAQUE_BIT = 1 << 15;

/**
 * texture的有效范围
 * 十进制：32767
 * 二进制：0111111111111111
 * 保留最高位，进行 V & OPAQUE_BIT 用来判断是否为空。
 */
export const TEXTURE_MASK = 0xffff - OPAQUE_BIT;

/**
 * AO Style 占用的位数
 */
export const AO_BITS = 2;

export const AO_SHIFT = 16;

/**
 * 右上位置顶点AO占用的位
 */
export const TR_AO_SHIFT = AO_SHIFT + AO_BITS;
export const BR_AO_SHIFT = AO_SHIFT + AO_BITS * 2;
export const BL_AO_SHIFT = AO_SHIFT + AO_BITS * 3;

/**
 * 一个 AO 数据的 Mask
 */
export const AO_MASK = (1 << AO_BITS) - 1;

/**
 * 占用 AO Style 高一位的位置表示表面的朝向（与AO数据顺序有关，正常是TopLeft顺时针，FLIP是TopRight逆时针）
 */
export const FLIP_BIT = 1 << (AO_SHIFT + 4 * AO_BITS);

/**
 * 面体素+AO数据，16+8+1 = 25bit，[FLIP(1bit), Surface AO(8bit), VOXEL(16bit)]
 */
export type AOSurfaceUint16 = number;
