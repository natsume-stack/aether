import { vec3 } from 'gl-matrix';
import { LabToRGB, RGBToLab } from '../../utils/color';
import type { SerializedVec3 } from '../../utils/math';

type Params = {
  /**
   * RGB颜色数组，数值为小数，即[R / 255, G / 255, B / 255]
   */
  rgbList: SerializedVec3[];
  /**
   * 聚类个数
   * 因为现在ui上颜色一排9个，先这么定
   * @default 9
   */
  k?: number;
  /**
   * 最大迭代次数
   * @default 50
   */
  maxIteration?: number;
};

/**
 * 通过k-means++的方式对颜色进行聚类
 * @returns 返回与输入的颜色数组等长的RGB颜色数组（非小数），
 */
export function kMeansPlus(params: Params) {
  const { rgbList, k = 9, maxIteration = 50 } = params;

  if (rgbList.length < k) {
    return rgbList;
  }

  /**
   * 是否继续迭代
   * 类中心发生变化后，重新计算每个颜色与中心的距离的均值。
   * 如果均值与中心点不同，则继续迭代。
   */
  let toContinue = true;
  // 当前迭代次数，超过最大迭代数时停止
  let iteration = 0;

  // 先把rgb转换为CIE-lab格式的数据
  const labList = rgbList.map(RGBToLab);

  // 初始化聚类的中心点
  let clusterList = initCluster(labList, k);

  // 按照输入的颜色数组长度返回
  let newColors: SerializedVec3[] = [];

  while (toContinue && iteration < maxIteration) {
    toContinue = false;
    iteration++;

    // 记录每个类的颜色数组
    const clusterColors: SerializedVec3[][] = [];

    labList.forEach((lab, labIdx) => {
      let minDist = Infinity;
      let minClusterIdx = -1;

      // 计算每个颜色与各个类的中心点的距离，找到距离最小的那个，存入对应的类的颜色数组
      clusterList.forEach((clusterColor, clusterIdx) => {
        const dist = vec3.dist(lab, clusterColor);

        if (minDist > dist) {
          minDist = dist;
          minClusterIdx = clusterIdx;
        }
      });

      // 更新类的颜色
      if (!clusterColors[minClusterIdx]) {
        clusterColors[minClusterIdx] = [];
      }

      clusterColors[minClusterIdx].push(lab);
      newColors[labIdx] = clusterList[minClusterIdx];
    });

    const newClusterList: SerializedVec3[] = [];

    clusterColors.forEach((list, idx) => {
      const sum: SerializedVec3 = [0, 0, 0];

      list.forEach((val) => {
        vec3.add(sum, val, sum);
      });

      vec3.scale(sum, sum, 1 / list.length);

      // 如果有中心点偏移，继续下次迭代
      if (!toContinue && vec3.dist(sum, clusterList[idx]) !== 0) {
        toContinue = true;
      }

      newClusterList.push(sum);
    });

    clusterList = newClusterList;
  }

  return newColors.map(LabToRGB);
}

/**
 * 用k-means++的方式初始化k个聚类。
 */
function initCluster(labList: SerializedVec3[], k: number) {
  const set = new Set<number>();

  // 随机一个点作为第一个类的中心点，这里粗暴地用第一个点
  const clusterList: SerializedVec3[] = [labList[0]];

  for (let i = 0; i < k - 1; i++) {
    let maxDist = -Infinity;
    let maxDistIdx = -1;

    labList.forEach((lab, labIdx) => {
      // k-means++的设计，遍历每个点，计算与上一个类的中心点距离最远的点，作为下一个类的中心点
      const dist = vec3.dist(lab, clusterList[clusterList.length - 1]);

      if (maxDist < dist && !set.has(labIdx)) {
        maxDist = dist;
        maxDistIdx = labIdx;
        set.add(labIdx);
      }
    });

    if (maxDistIdx > -1) {
      clusterList.push(labList[maxDistIdx]);
    }
  }

  return clusterList;
}
