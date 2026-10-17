import { defaultMotions } from '../defs';
import { IKPose, AvatarIKState } from '../interfaces';
import {
  mixIK,
  copyIK,
  playEmotePose,
  playCollapsePose,
} from '@box/schema/animation/compute-ik';
import {
  solveIKConfiguration,
  solveIKPoints,
} from '@box/schema/animation/solve-ik';
import {
  IKConfigurationSchema,
  IKPalette,
  IKPointSchema,
  IKPoseSchema,
  getTicksBySecond,
  rateKey,
  cycleKey,
} from '@box/schema/animation/ik-schema';

const BLENDS: IKPose[] = [];
const WEIGHTS: number[] = [];

const DEFAULT_RATE = 1 / getTicksBySecond(1);
const DEFAULT_CYCLE = 1;

export function computeIKState(
  motionName: string,
  state: AvatarIKState,
  palette: IKPalette,
  dt: number,
  iterations: number,
) {
  const keyframes: IKPose[] | IKPose | undefined = palette[motionName];

  if (!keyframes) {
    return;
  }

  // 如果动作只有一帧，不进行插值计算
  if (!Array.isArray(keyframes)) {
    copyIK(state.pose, keyframes);
  } else {
    BLENDS.length = 0;
    WEIGHTS.length = 0;

    if (motionName === defaultMotions.COLLAPSE) {
      playCollapsePose(
        { ikState: state, WEIGHTS, BLENDS },
        palette,
        state.groundEmotePhase,
        dt,
        iterations,
      );
    } else {
      playEmotePose(
        { ikState: state, WEIGHTS, BLENDS },
        {
          poses: keyframes,
          rate: palette[rateKey(motionName)] || DEFAULT_RATE,
          cycle: palette[cycleKey(motionName)] || DEFAULT_CYCLE,
        },
        palette,
        state.groundEmotePhase,
        dt,
        iterations,
      );
    }
    mixIK(state.pose, BLENDS, WEIGHTS, 1);
  }

  // apply breathing animation
  const breathPhase = (state.breathPhase + dt * palette.breathRate) % 1;
  state.breathPhase = breathPhase;
  applyBreathing(state.pose, breathPhase, palette.breathMagnitude);

  solveIKPoints(state.points, palette.skeleton, state.pose, 1);
  solveIKConfiguration(state.configuration, state.points, state.pose);
}

function applyBreathing(pose: IKPose, phase: number, scale: number) {
  const f = scale * Math.cos(Math.PI * 2 * phase);
  pose.leftShoulderPosition[1] += f;
  pose.rightShoulderPosition[1] += f;
}

export function initIKState() {
  const result: AvatarIKState = {
    groundEmotePhase: 0,
    jitterPhase: 0,
    breathPhase: 0,
    pose: IKPoseSchema.clone(IKPoseSchema.identity),
    points: IKPointSchema.clone(IKPointSchema.identity),
    configuration: IKConfigurationSchema.clone(IKConfigurationSchema.identity),
  };
  return result;
}
