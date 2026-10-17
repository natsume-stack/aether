import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { IKPose, IKRig } from '../../avatar/models/interfaces';
import { defaultMotions } from '../../avatar/models/defs';
import { store } from '../redux/store';
import {
  IKPaletteSchema,
  IKRigSchema,
  getTicksBySecond,
  rateKey,
} from '@box/schema/animation/ik-schema';

interface BVHSkeleton {
  transform: mat4;
  bones: BVHBone[];
  frames: BVHFrame[];
}

interface BVHBone {
  name: string;
  parent: number;
}

interface BVHFrame {
  translate: vec3[];
  rotate: quat[];
}

interface BVH {
  joints: JointSpec[];
  frameTime: number;
  frames: number[][];
}

interface JointSpec {
  name: string;
  offset: vec3;
  channels: string[];
  channelOffset: number;
  parent?: JointSpec;
  index: number;
}

const LEFT_TOE = 'r_foot_02';
const LEFT_FOOT = 'r_foot_01';
const LEFT_KNEE = 'r_up_leg_02';
const LEFT_HIP = 'r_up_leg';
const LEFT_SHOULDER = 'r_shoulder_01';
const LEFT_ELBOW = 'r_arm_01';
const LEFT_HAND = 'r_hand_03';

const RIGHT_TOE = 'l_foot_02';
const RIGHT_FOOT = 'l_foot_01';
const RIGHT_KNEE = 'l_up_leg_02';
const RIGHT_HIP = 'l_up_leg';
const RIGHT_SHOULDER = 'l_shoulder_01';
const RIGHT_ELBOW = 'l_arm_01';
const RIGHT_HAND = 'l_hand_03';

const HIPS = 'hips_02';
const HEAD = 'head_02';

export const IDLE_OFFSET = 1;
export const WALK_OFFSET = 2;
export const RUN_OFFSET = 10;

const JUMP_OFFSET = 18;
const FALL_OFFSET = 19;
const ROLL_OFFSET = 20;

export const LAND_OFFSET = 21;
const FLY_OFFSET = 22;
const SWIM_IDLE_OFFSET = 23;
const SWIM_OFFSET = 26;
const DEAD_OFFSET = 34;

const EMOTES_DATA: {
  [emoteName: string]: {
    offset: number;
    frames: number;
  };
} = {
  [defaultMotions.WAVE]: {
    offset: 40,
    frames: 20,
  },
  [defaultMotions.THOMAS]: {
    offset: 60,
    frames: 8,
  },
  [defaultMotions.SWING]: {
    offset: 68,
    frames: 31,
  },
  [defaultMotions.CHEER]: {
    offset: 99,
    frames: 9,
  },
  [defaultMotions.COLLAPSE]: {
    offset: 108,
    frames: 8,
  },
  [defaultMotions.APPLAUD]: {
    offset: 116,
    frames: 12,
  },
};

const SWIM_PHASE = 2;
const SWIM_IDLE_PHASE = 2;

export const WALK_PHASE = 0;
export const RUN_PHASE = 0;
export const CROUCH_PHASE = 0;
export const DEAD_PHASE = 0;

export function convertToPalette(bvhFile: string) {
  const bvhSkeleton = parseBVH(bvhFile);
  const ik = convertBVHToIK(bvhSkeleton);
  return {
    ikPalette: convertIKToIKPalette(ik.skeleton, ik.frames),
    extension: convertIKToExtension(ik.frames),
  };
}

function computeSkeleton(
  bindPose: mat4[],
  boneIds: { [id: string]: number },
): IKRig {
  // calculate position of all effectors
  const result = {
    footLength: 0,
    hipWidth: 0,
    neckLength: 0,
    shoulderWidth: 0,
    upperTorsoLength: 0,
    lowerTorsoLength: 0,
    upperLegLength: 0,
    lowerLegLength: 0,
    upperArmLength: 0,
    lowerArmLength: 0,
  };

  function getPoint(id: string) {
    return positionFromMatrix(vec3.create(), bindPose[boneIds[id]]);
  }

  const leftHandPos = getPoint(LEFT_HAND);
  const leftShoulderPos = getPoint(LEFT_SHOULDER);
  const leftElbow = getPoint(LEFT_ELBOW);
  result.upperArmLength = vec3.distance(leftElbow, leftShoulderPos) * 0.76;
  result.lowerArmLength = vec3.distance(leftHandPos, leftShoulderPos) * 0.5;

  const leftFootPos = getPoint(LEFT_FOOT);
  const leftUpperLegPos = getPoint(LEFT_HIP);

  const leftKneePos = getPoint(LEFT_KNEE);
  result.lowerLegLength = vec3.distance(leftFootPos, leftKneePos) * 0.985;
  result.upperLegLength = vec3.distance(leftKneePos, leftUpperLegPos) * 0.985;

  const leftToePos = getPoint(LEFT_TOE);
  result.footLength = vec3.distance(leftFootPos, leftToePos);

  const rightUpperLegPos = getPoint(RIGHT_HIP);
  result.hipWidth = vec3.distance(rightUpperLegPos, leftUpperLegPos);

  const rightShoulderPos = getPoint(RIGHT_SHOULDER);
  result.shoulderWidth = vec3.distance(leftShoulderPos, rightShoulderPos);

  const neckPos = getPoint(HEAD);
  const neckBase = vec3.lerp(
    vec3.create(),
    leftShoulderPos,
    rightShoulderPos,
    0.5,
  );
  result.neckLength = vec3.distance(neckBase, neckPos);

  const hipPos = getPoint(HIPS);
  const torsoLength = vec3.distance(hipPos, neckBase);
  result.lowerTorsoLength = result.upperTorsoLength = 0.5 * torsoLength;

  return result;
}

function convertBVHToIK(skeleton: BVHSkeleton) {
  const boneIds: { [id: string]: number } = {};
  const frames: IKPose[] = [];
  for (let i = 0; i < skeleton.bones.length; ++i) {
    boneIds[skeleton.bones[i].name] = i;
  }
  const bindPose = [];
  computeBVHPose(bindPose, skeleton, skeleton.frames[0]);
  const ikSkeleton = computeSkeleton(bindPose, boneIds);

  function adjustArmsPosition(base1, base2, target) {
    base1[14] = base2[14] = target[14];
  }

  for (let i = 0; i < skeleton.frames.length; ++i) {
    const pose: mat4[] = [];
    computeBVHPose(pose, skeleton, skeleton.frames[i]);
    if (i === 0) {
      adjustArmsPosition(
        pose[boneIds[RIGHT_HAND]],
        pose[boneIds[RIGHT_ELBOW]],
        pose[boneIds[RIGHT_SHOULDER]],
      );
      adjustArmsPosition(
        pose[boneIds[LEFT_HAND]],
        pose[boneIds[LEFT_ELBOW]],
        pose[boneIds[LEFT_SHOULDER]],
      );
    }
    frames.push(convertIKPose(pose, boneIds));
  }

  return {
    skeleton: ikSkeleton,
    frames,
  };
}

function convertIKToIKPalette(skeleton: IKRig, frames: IKPose[]) {
  // 脚是否贴地面的矫正，暂时没有开放给美术调整，按照原本的设定写死
  const IDLE = frames[IDLE_OFFSET];
  const LAND = frames[LAND_OFFSET];
  IDLE.leftPlant = IDLE.rightPlant = 1;
  LAND.leftPlant = LAND.rightPlant = 1;

  frames[WALK_OFFSET].rightPlant = frames[WALK_OFFSET + 7].rightPlant = 1;
  frames[WALK_OFFSET + 3].leftPlant = frames[WALK_OFFSET + 4].leftPlant = 1;
  frames[RUN_OFFSET].rightPlant = frames[RUN_OFFSET + 7].rightPlant = 1;
  frames[RUN_OFFSET + 3].leftPlant = frames[RUN_OFFSET + 4].leftPlant = 1;

  const { wave, swing, applaud } = EMOTES_DATA;
  for (let i = wave.offset; i < wave.offset + wave.frames; i++) {
    frames[i].rightPlant = frames[i].leftPlant = 1;
  }
  for (let i = swing.offset; i < swing.offset + swing.frames; i++) {
    frames[i].rightPlant = frames[i].leftPlant = 1;
  }
  for (let i = applaud.offset; i < applaud.offset + applaud.frames; i++) {
    frames[i].rightPlant = frames[i].leftPlant = 1;
  }

  const iKPalette = IKPaletteSchema.clone(IKPaletteSchema.identity);
  iKPalette.skeleton = IKRigSchema.clone(skeleton);

  iKPalette.idle = frames[IDLE_OFFSET];
  iKPalette.jump = frames[JUMP_OFFSET];
  iKPalette.fall = frames[FALL_OFFSET];
  iKPalette.land = frames[LAND_OFFSET];
  iKPalette.roll = frames[ROLL_OFFSET];
  iKPalette.fly = frames[FLY_OFFSET];

  for (let i = 0; i < 6; ++i) {
    iKPalette.dead.push(frames[((i + DEAD_PHASE) % 6) + DEAD_OFFSET]);
  }

  for (let i = 0; i < 8; i++) {
    iKPalette.walk.push(frames[((i + WALK_PHASE) % 8) + WALK_OFFSET]);
    iKPalette.run.push(frames[((i + RUN_OFFSET) % 8) + RUN_OFFSET]);
    iKPalette.swim.push(frames[((i + SWIM_PHASE) % 8) + SWIM_OFFSET]);
  }

  for (let i = 0; i < 3; ++i) {
    iKPalette.swimIdle.push(
      frames[((i + SWIM_IDLE_PHASE) % 3) + SWIM_IDLE_OFFSET],
    );
  }

  for (const emoteName in EMOTES_DATA) {
    const emote = EMOTES_DATA[emoteName];
    for (let i = 0; i < emote.frames; i++) {
      iKPalette[emoteName].push(frames[(i % emote.frames) + emote.offset]);
    }
  }

  return iKPalette;
}

/**
 * 根据frames和store的数据生成一些avatar单独使用的表情拓展包
 * @param frames
 * @returns
 */
function convertIKToExtension(frames: IKPose[]) {
  // 一些额外的只在avatar展示用的动作
  const extensionMotion = {};

  extensionMotion[defaultMotions.DEFAULT] = frames[0];

  const { newMotions } = store.getState().app;

  for (let i = 0; i < newMotions.length; i++) {
    const { name, frameCount, frameOffset, playTime } = newMotions[i];
    extensionMotion[rateKey(name)] = 1 / getTicksBySecond(playTime);
    extensionMotion[name] = [];
    for (let j = 0; j < frameCount; j++) {
      extensionMotion[name].push(frames[(j % frameCount) + frameOffset]);
    }
  }
  return extensionMotion;
}

function parseBVH(bvhFile: string) {
  const parseBVH = require('parse-bvh');
  const bvh = parseBVH(bvhFile) as BVH;

  const bvhSkeleton: BVHSkeleton = {
    transform: mat4.create(),
    bones: [],
    frames: new Array(bvh.frames.length),
  };

  const boneIndex = new Array<number>(bvh.joints.length);
  for (let i = 0; i < bvh.joints.length; ++i) {
    const joint = bvh.joints[i];
    if (joint.channels.length > 0) {
      boneIndex[i] = bvhSkeleton.bones.length;
      const b = convertBone(bvh.joints[i]);
      if (b.parent >= 0) {
        b.parent = boneIndex[b.parent];
      }
      bvhSkeleton.bones.push(b);
    } else {
      boneIndex[i] = -1;
    }
  }

  for (let i = 0; i < bvh.frames.length; ++i) {
    bvhSkeleton.frames[i] = convertFrame(
      boneIndex,
      bvhSkeleton.bones,
      bvh.joints,
      bvh.frames[i],
    );
  }

  return bvhSkeleton;
}

function convertBone(joint: JointSpec) {
  const result: BVHBone = {
    name: joint.name,
    parent: joint.parent ? joint.parent.index : -1,
  };
  return result;
}

function convertFrame(
  boneIndex: number[],
  bones: BVHBone[],
  joints: JointSpec[],
  params: number[],
) {
  const frame: BVHFrame = {
    translate: new Array<vec3>(bones.length),
    rotate: new Array<quat>(bones.length),
  };

  for (let i = 0; i < joints.length; ++i) {
    const joint = joints[i];
    if (joint.channels.length === 0) {
      continue;
    }
    const v = (frame.translate[boneIndex[i]] = vec3.create());
    const q = (frame.rotate[boneIndex[i]] = quat.create());
    vec3.copy(v, joint.offset);
    quat.identity(q);
    const channels = joint.channels;
    const offset = joint.channelOffset;
    for (let j = 0; j < channels.length; ++j) {
      const p = params[offset + j];
      switch (channels[j]) {
        case 'Xposition':
          v[0] += p;
          break;
        case 'Yposition':
          v[1] += p;
          break;
        case 'Zposition':
          v[2] += p;
          break;
        case 'Xrotation':
          quat.rotateX(q, q, (p * Math.PI) / 180);
          break;
        case 'Yrotation':
          quat.rotateY(q, q, (p * Math.PI) / 180);
          break;
        case 'Zrotation':
          quat.rotateZ(q, q, (p * Math.PI) / 180);
          break;
      }
    }
  }

  return frame;
}

function computeBVHPose(
  result: mat4[],
  skeleton: BVHSkeleton,
  frame: BVHFrame,
) {
  const bones = skeleton.bones;
  for (let i = 0; i < bones.length; ++i) {
    const m = mat4.create();
    mat4.fromRotationTranslation(m, frame.rotate[i], frame.translate[i]);
    const parent = bones[i].parent;
    if (parent >= 0) {
      mat4.multiply(m, result[parent], m);
    } else {
      mat4.multiply(m, skeleton.transform, m);
    }
    result[i] = m;
  }
}

function positionFromMatrix(out: vec3, pose: mat4) {
  out[0] = pose[12];
  out[1] = pose[13];
  out[2] = pose[14];
  return out;
}

function getInitIKPose() {
  return {
    // left leg
    leftPlant: 0,
    leftFootPosition: vec3.create(),
    leftToePosition: vec3.create(),
    leftKneeDirection: vec3.create(),

    // right leg
    rightPlant: 0,
    rightFootPosition: vec3.create(),
    rightToePosition: vec3.create(),
    rightKneeDirection: vec3.create(),

    // left arm
    leftHandPosition: vec3.create(),
    leftHandOrientation: quat.create(),
    leftElbowDirection: vec3.create(),
    leftShoulderPosition: vec3.create(),

    // right arm
    rightHandPosition: vec3.create(),
    rightHandOrientation: quat.create(),
    rightElbowDirection: vec3.create(),
    rightShoulderPosition: vec3.create(),

    // torso and hips
    hipPosition: vec3.create(),
    hipOrientation: quat.create(),
    spineDirection: vec3.create(),

    // head
    headPosition: vec3.create(),
    headOrientation: quat.create(),
  };
}

function convertIKPose(bvhPose: mat4[], boneIds: { [id: string]: number }) {
  const result = getInitIKPose();

  function point(id: string) {
    return positionFromMatrix(vec3.create(), bvhPose[boneIds[id]]);
  }

  function frame(id: string) {
    const M = bvhPose[boneIds[id]];
    const R = mat3.fromMat4(mat3.create(), M);
    const Q = quat.fromMat3(quat.create(), R);
    const A = quat.identity(quat.create());
    quat.rotateY(A, A, Math.PI);
    quat.mul(Q, Q, A);
    quat.normalize(Q, Q);
    return Q;
  }

  function copy(position: vec3, orientation: quat, link: string) {
    vec3.copy(position, point(link));
    quat.copy(orientation, frame(link));
  }

  function computeBendDir(
    out: vec3,
    base: string,
    joint: string,
    effector: string,
  ) {
    const d = vec3.subtract(vec3.create(), point(effector), point(base));
    vec3.normalize(d, d);

    const j = point(joint);
    const n = vec3.subtract(out, j, point(effector));
    vec3.scaleAndAdd(n, n, d, -vec3.dot(d, n));
    vec3.normalize(n, n);
  }

  copy(result.hipPosition, result.hipOrientation, HIPS);
  copy(result.headPosition, result.headOrientation, HEAD);
  copy(result.leftHandPosition, result.leftHandOrientation, LEFT_HAND);
  copy(result.rightHandPosition, result.rightHandOrientation, RIGHT_HAND);
  vec3.copy(result.leftFootPosition, point(LEFT_FOOT));
  vec3.copy(result.rightFootPosition, point(RIGHT_FOOT));
  vec3.copy(result.leftToePosition, point(LEFT_TOE));
  vec3.copy(result.rightToePosition, point(RIGHT_TOE));

  vec3.copy(result.leftShoulderPosition, point(LEFT_SHOULDER));
  vec3.copy(result.rightShoulderPosition, point(RIGHT_SHOULDER));

  computeBendDir(result.leftKneeDirection, LEFT_HIP, LEFT_KNEE, LEFT_FOOT);
  computeBendDir(
    result.leftElbowDirection,
    LEFT_SHOULDER,
    LEFT_ELBOW,
    LEFT_HAND,
  );
  computeBendDir(result.rightKneeDirection, RIGHT_HIP, RIGHT_KNEE, RIGHT_FOOT);
  computeBendDir(
    result.rightElbowDirection,
    RIGHT_SHOULDER,
    RIGHT_ELBOW,
    RIGHT_HAND,
  );

  const hipFrame = mat3.create();
  mat3.fromQuat(hipFrame, result.hipOrientation);
  result.spineDirection[0] = -hipFrame[2];
  result.spineDirection[1] = -hipFrame[5];
  result.spineDirection[2] = -hipFrame[8];

  return result;
}
