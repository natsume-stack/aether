import { useLayoutEffect, useRef } from 'react';
import { initRegl } from '../models/rendering/regl';
import { getQueryValue, getQueryValueNumber } from '../utils/url';
import { Avatar } from './models/avatar';
import style from './style.module.scss';

const enum QueryKey {
  background = 'background',
  align = 'align',
  avatarHeight = 'avatarHeight',
  pitch = 'pitch',
  yaw = 'yaw',
}

export default function AvatarView() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const avatar = useRef<Avatar | undefined>(undefined);

  useLayoutEffect(() => {
    if (!canvas.current) {
      return;
    }
    initRegl(canvas.current).then((regl) => {
      avatar.current = new Avatar({
        regl: regl,
      });
      avatar.current.load({
        background:
          getQueryValue(window.location.href, QueryKey.background) === 'true',
        align: getQueryValue(window.location.href, QueryKey.align),
        avatarHeight: getQueryValueNumber(
          window.location.href,
          QueryKey.avatarHeight,
        ),
        pitch: getQueryValueNumber(window.location.href, QueryKey.pitch),
        yaw: getQueryValueNumber(window.location.href, QueryKey.yaw),
      });
    });
    return () => {
      avatar.current?.destroy();
    };
  }, []);

  return (
    <div className={style.canvasContainer}>
      <canvas ref={canvas} />
    </div>
  );
}
