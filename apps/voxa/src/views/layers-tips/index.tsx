import React, { CSSProperties, useMemo } from 'react';
import { Tooltip } from '@box/box-design';
import { useAppSelector } from '../../redux/store';

/**
 * “提示”与体素顶点的水平距离。源于设计稿。
 */
const TIPS_OFFSET = 8;

export function LayersTips() {
  const { layers: hint, position } = useAppSelector(
    (state) => state.editing.layersTips,
  );

  const [x, y] = position;

  const style = useMemo<CSSProperties>(() => {
    return {
      left: `${x + TIPS_OFFSET}px`,
      top: `${y}px`,
      position: 'fixed',
    };
  }, [x, y]);

  return <Tooltip text={hint} style={style} />;
}
