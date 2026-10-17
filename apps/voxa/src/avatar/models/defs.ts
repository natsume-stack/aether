import type { IKPalette } from './interfaces';
import { BodyPart } from '@box/schema/player/player-schema';
import extensionJSON from './animation/extension.json';
import playerAnimJSON from './animation/player-anim.json';
import { ScreenshotMode } from './iframe';

export const DEFAULT_IK_PALETTE: IKPalette = JSON.parse(
  JSON.stringify(playerAnimJSON),
);

export const DEFAULT_EXTENSION = JSON.parse(JSON.stringify(extensionJSON));

type PartName = keyof typeof BodyPart;
export const BodyPartName: {
  [K in PartName]: PartName;
} = {
  hips: 'hips',
  torso: 'torso',
  neck: 'neck',
  head: 'head',
  leftShoulder: 'leftShoulder',
  leftUpperArm: 'leftUpperArm',
  leftLowerArm: 'leftLowerArm',
  leftHand: 'leftHand',
  rightShoulder: 'rightShoulder',
  rightUpperArm: 'rightUpperArm',
  rightLowerArm: 'rightLowerArm',
  rightHand: 'rightHand',
  leftUpperLeg: 'leftUpperLeg',
  leftLowerLeg: 'leftLowerLeg',
  leftFoot: 'leftFoot',
  rightUpperLeg: 'rightUpperLeg',
  rightLowerLeg: 'rightLowerLeg',
  rightFoot: 'rightFoot',
};

export enum defaultMotions {
  DEFAULT = 'default',
  IDLE = 'idle',
  JUMP = 'jump',
  FALL = 'fall',
  ROLL = 'roll',
  FLY = 'fly',
  LAND = 'land',
  WALK = 'walk',
  RUN = 'run',
  SWIM = 'swim',
  SWIM_IDLE = 'swimIdle',
  DEAD = 'dead',
  WAVE = 'wave',
  THOMAS = 'thomas',
  SWING = 'swing',
  CHEER = 'cheer',
  COLLAPSE = 'collapse',
  APPLAUD = 'applaud',
}

export const DEFAULT_ITERATIONS = 0;

/**
 * 截图模式对应应该显示的部件映射
 */
export const ScreenshotModePartsMap = {
  [ScreenshotMode.Suit]: [...Object.values(BodyPartName)],
  [ScreenshotMode.Head]: [BodyPartName.head, BodyPartName.neck],
  [ScreenshotMode.Shirt]: [
    BodyPartName.leftHand,
    BodyPartName.leftLowerArm,
    BodyPartName.leftUpperArm,
    BodyPartName.leftShoulder,
    BodyPartName.rightHand,
    BodyPartName.rightLowerArm,
    BodyPartName.rightUpperArm,
    BodyPartName.rightShoulder,
    BodyPartName.torso,
  ],
  [ScreenshotMode.Pants]: [
    BodyPartName.hips,
    BodyPartName.leftLowerLeg,
    BodyPartName.leftUpperLeg,
    BodyPartName.rightLowerLeg,
    BodyPartName.rightUpperLeg,
  ],
  [ScreenshotMode.Shoes]: [BodyPartName.leftFoot, BodyPartName.rightFoot],
};

/**
 * 截图的时候摄像机的角度以及移动的距离
 * 这里记录不同截图模式对应的不同摄像机设置
 */
export const ScreenshotCameraMap: {
  [key in ScreenshotMode]: {
    /**
     * 摄像机角度，单位为角度
     */
    dir: {
      /**
       * 俯仰角
       */
      pitch: number;
      /**
       * 偏航角
       */
      yaw: number;
    };
    /**
     * 摄像机移动的距离
     */
    dist: number;
    /**
     * 截图目标盒子大小
     * 选填，默认是截图时候计算体素围成的最小立方体
     * 目前是各部位截图的时候是标准固定的盒子
     */
    box?: {
      max: [number, number, number];
      min: [number, number, number];
    };
  };
} = {
  [ScreenshotMode.Share]: {
    dir: {
      pitch: 4,
      yaw: 10,
    },
    dist: 3.2,
  },
  [ScreenshotMode.Avatar]: {
    dir: {
      pitch: 4,
      yaw: 10,
    },
    dist: 2.14,
    box: {
      max: [0.5619410872459412, 2.128039836883545, 0.6694737076759338],
      min: [-0.5589731335639954, 0.9760432243347168, -0.46763649582862854],
    },
  },
  [ScreenshotMode.Suit]: {
    dir: {
      pitch: 4,
      yaw: 10,
    },
    dist: 3.2,
    box: {
      max: [0.5619350671768188, 2.1256675720214844, 0.6692151427268982],
      min: [-0.650916576385498, 0.012732738628983498, -0.4678950905799866],
    },
  },
  [ScreenshotMode.Head]: {
    dir: {
      pitch: 4,
      yaw: 10,
    },
    dist: 2.04,
    box: {
      max: [0.5619347095489502, 2.1255249977111816, 0.6691998243331909],
      min: [-0.5589795112609863, 0.973528265953064, -0.46791040897369385],
    },
  },
  [ScreenshotMode.Shirt]: {
    dir: {
      pitch: 0,
      yaw: 0,
    },
    dist: 1.74,
    box: {
      max: [0.5399103164672852, 1.1917533874511719, 0.48124969005584717],
      min: [-0.650916576385498, 0.4698416292667389, -0.26363232731819153],
    },
  },
  [ScreenshotMode.Pants]: {
    dir: {
      pitch: 15,
      yaw: 20,
    },
    dist: 1.41,
    box: {
      max: [0.3681720197200775, 0.8783136010169983, 0.29038509726524353],
      min: [-0.3795185983181, 0.0725267231464386, -0.22421596944332123],
    },
  },
  [ScreenshotMode.Shoes]: {
    dir: {
      pitch: 15,
      yaw: -10,
    },
    dist: 1.2,
    box: {
      max: [0.3833261728286743, 0.21336713433265686, 0.2658328115940094],
      min: [-0.39414557814598083, 0.012732738628983498, -0.23186984658241272],
    },
  },
};

export const createraDevTestData = {
  hips: 'qANxetj4QBSF0E6EM0dlkWfPfPwDoRoK73lywsjQJeg',
  torso: 'KA2aBPqZrMqlo3SvnQZ0uQkevZFZMzNYS1sDUxyKvMw',
  neck: 'oShx_uIQ-4YZKR6uoZRYHL0lMeSyN1nSJfaAaSP2MiI',
  head: 'Td6yxe7JnX5kEAgubBCxdymfFkCP0Gl3LGEb5Zw7Pp0',
  leftShoulder: 'qNXdY_ukcevLHz6PfB4YebcVKm5ymKkc4RmmNACt58U',
  leftUpperArm: 'nkaK4C2dtuAJdA6Zc4sho_KFxEHo4PeSSVvPscdGzkY',
  leftLowerArm: 's0RhN_vK12e9tYyHwDoxd0R3WIRMnYHZGuG5rfqPDAk',
  leftHand: 'uBTvfklo0YZFiRGuWg_frFJeUAXIN3LIw-5bHgOt3_U',
  rightShoulder: 'nmKC5PJeNwzmF-Idb-Jl6Iuee4aCzwAFm50SjZOB8J0',
  rightUpperArm: 'YXtQXi8Rc7aJia6dw9jBr75yTNu5SJ9HWPlx5YaKLOk',
  rightLowerArm: 'xBOzPfNxQyu5jhkeCc2UGBnlI4VjgUC10xq6OtraObg',
  rightHand: 'EuFjBHcAXz6C6UIvD3iiIotABvulyrBVlEM78h6j8q0',
  leftUpperLeg: 'vIX79hIppika-a5pD2umTPH9W37SzhZrJugvuD-1hoY',
  leftLowerLeg: 'LZXMN9Gj_h37505d3-a2nLniBhsMlxPvWGeJufy2qxA',
  leftFoot: 'QsChSN6D09VRaaY39TtrlaJkgz11weQOGSiQVWRQeFo',
  rightUpperLeg: 'xI54eteHf1IImjYZCCfAgcQlARilJjSbLydGzPIcWNA',
  rightLowerLeg: '00ahrj57FgVdeBts3XRhVSiqc2IiFZTCX6QJW_jP4tk',
  rightFoot: 'uOcKQUYA4lCKV5KxRKflHYmFhahaAjeOO9VlD5h7U_g',
};
