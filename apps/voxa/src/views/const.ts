import {
  InterpolationType,
  ProjectInterpolationType,
} from '../redux/animator-slice';

export const INTERPOLATION_TO_ICON: Record<InterpolationType, string> = {
  [ProjectInterpolationType.Step]: '#icon-motion-step',
  [ProjectInterpolationType.Linear]: '#icon-motion-linear',
  [ProjectInterpolationType.EaseInOutSine]: '#icon-motion-ease-in-out',
  [ProjectInterpolationType.EaseInSine]: '#icon-motion-ease-in',
  [ProjectInterpolationType.EaseOutSine]: '#icon-motion-ease-out',
};
