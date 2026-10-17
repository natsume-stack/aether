import { useLayoutEffect, useRef, createContext, useState } from 'react';
import { Provider } from 'react-redux';
import { initRegl } from '../models/rendering/regl';
import { Avatar } from '../avatar/models/avatar';
import { SkinPanel } from './components/skin-panel';
import { SkeletonPanel } from './components/skeleton-panel';
import { BoneMesh } from './utils/bone-mesh';
import { store } from './redux/store';
import style from './style.module.scss';

export const AvatarContext = createContext<Avatar | undefined>(undefined);

export default function AvatarView() {
  const [avatar, setAvatar] = useState<Avatar | undefined>(undefined);
  const canvas = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    if (!canvas.current) {
      return;
    }
    let avatar: Avatar | undefined;
    initRegl(canvas.current).then((regl) => {
      avatar = new Avatar({
        regl: regl,
      });
      // 给每块骨头🦴添加样式
      for (const skinPart of avatar.skinParts.values()) {
        skinPart.parent?.add(new BoneMesh(regl));
      }
      avatar.load({ background: true });
      setAvatar(avatar);
    });
    return () => {
      avatar?.destroy();
    };
  }, []);

  return (
    <Provider store={store}>
      <AvatarContext.Provider value={avatar}>
        <div className={style.page}>
          <div className={style.canvasContainer}>
            <canvas ref={canvas} />
          </div>
          <SkinPanel />
          <SkeletonPanel />
        </div>
      </AvatarContext.Provider>
    </Provider>
  );
}
