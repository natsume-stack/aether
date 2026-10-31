import { drawForceStraightLine, drawLine } from '../../../utils/line';
import { isInvalidPosition } from '../util';
import { EditModeParams } from './interfaces';

interface ParseParams extends EditModeParams {
  /**
   * 转换的起点序号
   * @default 0
   */
  startIdx?: number;
  /**
   * 是否强制绘制平行于轴的直线
   */
  forceStraight?: boolean;
}

export class Line {
  /**
   * 把体素点集合按照连线的方式加工。每2个点生成1条体素线段。
   * @param collection
   * @param startIndex
   */
  public parse({
    operation,
    collection,
    startIdx = 0,
    forceStraight = false,
  }: ParseParams) {
    const length = collection.length - startIdx;

    if (length === 0) {
      return;
    }

    if (length === 1) {
      const [pos] = collection;

      operation({ pos });

      return;
    }

    const draw = forceStraight ? drawForceStraightLine : drawLine;

    for (let i = startIdx; i < collection.length - 1; i++) {
      const start = collection[i];
      const end = collection[i + 1];

      if (isInvalidPosition(start) || isInvalidPosition(end)) {
        continue;
      }

      draw({
        start,
        end,
        operation,
      });
    }
  }
}
