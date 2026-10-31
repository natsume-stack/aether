import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { ModalView, Input } from '@box/box-design';
import {
  DEFAULT_EXTENSION,
  DEFAULT_IK_PALETTE,
} from '../../../avatar/models/defs';

import { exportIKExtension, exportIKPalette } from '../../utils/file';
import { convertToPalette } from '../../utils/bvh';
import { defaultMotions } from '../../../avatar/models/defs';
import { AvatarContext } from '../..';
import { useAppSelector } from '../../redux/store';
import { setNewMotions } from '../../redux/app';
import style from './style.module.scss';

export function SkeletonPanel() {
  const avatar = useContext(AvatarContext);
  const newMotions = useAppSelector((state) => state.app.newMotions);
  const dispatch = useDispatch();

  const tempBVH = useRef<string>();
  const [showImportBVH, setShowImportBVH] = useState(false);

  const [motionName, setMotionName] = useState<string>();
  const [frameCount, setFrameCount] = useState<number>();
  const [frameOffset, setFrameOffset] = useState<number>();
  const [playTime, setPlayTime] = useState<number>();

  const closeImportModal = useCallback(() => {
    setShowImportBVH(false);
    setMotionName(undefined);
    setFrameCount(undefined);
    setFrameOffset(undefined);
  }, []);

  const importBVHContent = useMemo(() => {
    return (
      <div>
        <input
          type="file"
          accept=".bvh"
          onChange={(ev) => {
            const files = ev.target.files;
            if (!files || files.length === 0) {
              return;
            }
            const f = files[0];
            const reader = new FileReader();
            reader.readAsText(f);
            reader.onload = () => {
              tempBVH.current = reader.result as string;
            };
          }}
        />
        <div>
          <div className={style.title}>新增动作列表</div>
          {newMotions.map((newMotion) => {
            return (
              <div key={newMotion.name}>
                {newMotion.name}
                <button
                  onClick={() => {
                    const clonedNewMotions = newMotions.slice();
                    clonedNewMotions.splice(
                      clonedNewMotions.findIndex(
                        (i) => i.name === newMotion.name,
                      ),
                      1,
                    );
                    dispatch(setNewMotions(clonedNewMotions));
                  }}
                >
                  删除
                </button>
              </div>
            );
          })}
        </div>
        <div>
          <div className={style.title}>新增动作</div>
          <label className={style.fileLabel}>
            动作名字
            <Input
              type={'primary'}
              size={'small'}
              valueType={'string'}
              value={motionName}
              onBlur={(value) => {
                setMotionName(value);
              }}
            />
          </label>
          <label className={style.fileLabel}>
            动作帧数
            <Input
              type={'primary'}
              size={'small'}
              valueType={'number'}
              value={frameCount}
              onBlur={(value) => {
                setFrameCount(parseInt(value));
              }}
            />
          </label>
          <label className={style.fileLabel}>
            动作起始帧
            <Input
              type={'primary'}
              size={'small'}
              valueType={'number'}
              value={frameOffset}
              onBlur={(value) => {
                setFrameOffset(parseInt(value));
              }}
            />
          </label>

          <label className={style.fileLabel}>
            动作时长
            <Input
              type={'primary'}
              size={'small'}
              valueType={'number'}
              value={playTime}
              onBlur={(value) => {
                setPlayTime(parseFloat(value));
              }}
            />
          </label>
          <button
            onClick={() => {
              if (
                motionName === undefined ||
                frameCount === undefined ||
                frameOffset === undefined ||
                playTime === undefined
              ) {
                return;
              }
              const checkName = newMotions.find((i) => i.name === motionName);
              // 有重名
              if (checkName) {
                return;
              }
              dispatch(
                setNewMotions(
                  newMotions.concat({
                    name: motionName,
                    frameCount: frameCount,
                    frameOffset,
                    playTime,
                  }),
                ),
              );
            }}
          >
            确认添加新动作
          </button>
        </div>
      </div>
    );
  }, [newMotions, frameCount, motionName, frameOffset, playTime, dispatch]);

  const applyBVH = useMemo(() => {
    return (
      <div>
        <button
          className={style.title}
          onClick={() => {
            if (!avatar) {
              return;
            }
            avatar.ikPalette = DEFAULT_IK_PALETTE;
            avatar.extension = DEFAULT_EXTENSION;
            avatar.palette = Object.assign(avatar.ikPalette, avatar.extension);
            avatar.playMotion(defaultMotions.IDLE);
            dispatch(setNewMotions([]));
          }}
        >
          使用默认骨骼
        </button>
        <div className={style.title}>导入解析并使用BVH</div>
        <button
          className={style.label}
          onClick={() => {
            setShowImportBVH(true);
          }}
        >
          点击导入
        </button>
        {showImportBVH && (
          <ModalView
            content={importBVHContent}
            onConfirm={() => {
              if (!avatar || !tempBVH.current) {
                return;
              }
              const { ikPalette, extension } = convertToPalette(
                tempBVH.current,
              );
              avatar.ikPalette = ikPalette;
              avatar.extension = extension;
              avatar.palette = Object.assign(ikPalette, extension);
              closeImportModal();
            }}
            onCancel={() => {
              tempBVH.current = undefined;
              closeImportModal();
            }}
          />
        )}
      </div>
    );
  }, [avatar, importBVHContent, showImportBVH, closeImportModal, dispatch]);

  const exportBVH = useMemo(() => {
    return (
      <div>
        <div className={style.title}>导出当前骨骼数据</div>
        <div>
          <label className={style.label}>avatar拓展包</label>
          <button
            onClick={() => {
              avatar && exportIKExtension(avatar.extension);
            }}
          >
            Export extension.json
          </button>
        </div>
        <div>
          <label className={style.label}>地图使用</label>
          <button
            className={style.label}
            onClick={() => {
              avatar && exportIKPalette(avatar.ikPalette);
            }}
          >
            Export player-anim.json
          </button>
        </div>
      </div>
    );
  }, [avatar]);

  const motionNames = useMemo(() => {
    const names: string[] = Object.values(defaultMotions);
    newMotions.forEach((newMotion) => {
      names.push(newMotion.name);
    });
    return names;
  }, [newMotions]);

  return (
    <div className={style.skeletonPanel}>
      <div>
        <div className={style.title}>切换动作</div>
        <select
          onChange={(ev) => {
            avatar?.playMotion(ev.target.value);
          }}
        >
          {motionNames.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </div>
      {applyBVH}
      {exportBVH}
    </div>
  );
}
