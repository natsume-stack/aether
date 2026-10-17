import { vec3 } from 'gl-matrix';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { migrateProject } from '@box/voxa-project';
import { Button, ModalView, Input } from '@box/box-design';
import type { SkinPart } from '../../../avatar/models/skin-part';
import { setSelectedSkinId } from '../../redux/app';
import { store, useAppSelector } from '../../redux/store';
import { exportSkin, exportSkinZip, exportVoxaProject } from '../../utils/file';
import { VectorInput } from './vector-input';
import style from './style.module.scss';
import { getEuler } from '../../../models/rendering/math/quat';
import { AvatarContext } from '../..';
import { voxelsToMeshes } from 'packages/mesher/build';
import {
  BODY_PART_DEFAULT_ROTATIONS,
  BODY_PART_DEFAULT_SCALE,
} from '@box/schema/player/player-schema';
import { migrateJSON } from '../../utils/migrate';
import { VoxParser } from '../../../common/vox-parser';
import {
  EmitEvents,
  ScreenshotMode,
  SuitList,
} from '../../../avatar/models/iframe';
import { apis } from '../../apis';
import { clientConfig } from '../../config';

export function SkinPanel() {
  const avatar = useContext(AvatarContext);
  const voxParser = useRef(new VoxParser());

  const selectedSkinId = useAppSelector((state) => state.app.selectedSkinId);
  const [skinPart, setSkinPart] = useState<SkinPart | undefined>(
    avatar?.skinParts.get(selectedSkinId),
  );
  const [scaleOffset, setScaleOffset] = useState<vec3>(vec3.create());
  const [positionOffset, setPositionOffset] = useState<vec3>(vec3.create());
  const [eulerOffset, setEulerOffset] = useState<vec3>(
    vec3.fromValues(0, 0, 0),
  );

  const [showExportVoxa, setShowExportVoxa] = useState(false);
  const [voxaHash, setVoxaHash] = useState<string>();

  useEffect(() => {
    const skinPart = avatar?.skinParts.get(selectedSkinId);
    if (skinPart) {
      setSkinPart(skinPart);
    }
  }, [avatar, selectedSkinId]);

  useEffect(() => {
    if (!skinPart) {
      return;
    }
    setScaleOffset(skinPart.scale);
    setPositionOffset(skinPart.position);
    const euler = vec3.create();
    getEuler(euler, skinPart.quaternion);
    setEulerOffset(euler);
  }, [skinPart]);

  const skinPartsOptions = useMemo(() => {
    if (!avatar) {
      return;
    }
    return Array.from(avatar.skinParts.keys()).map((name) => {
      return (
        <option key={name} value={name}>
          {name}
        </option>
      );
    });
  }, [avatar]);

  const clearSkinParts = useCallback(() => {
    avatar?.skinParts.forEach((sp) => sp.makeEmpty());
  }, [avatar]);

  const loadVoxData = useCallback(
    async (file: File) => {
      if (!avatar) {
        return;
      }
      const voxFile = await voxParser.current.parseMagicaVoxel(file);
      if (!voxFile) {
        return;
      }

      const { nTRN, nGRP, nSHP, XYZI, SIZE, RGBA } = voxFile;
      if (!nTRN || !nGRP || !nSHP) {
        window.alert('Should use multiple vox file');
        return;
      }

      const palette: [number, number, number][] = RGBA.map((v) => {
        if (!v) {
          return [0, 0, 0];
        }
        return [v.r, v.g, v.b];
      });
      // 第0位颜色无意义，但需要填充数据，避免mesher报错
      palette[0] = [0, 0, 0];
      // 填充发光数据。皮肤不发光，为0即可
      const emissiveList: number[] = new Array(palette.length).fill(0);

      voxParser.current.parseVoxParts({
        nGRP,
        nTRN,
        nSHP,
        XYZI,
        SIZE,
        onParseSingleVox: async (params) => {
          const { name, voxelInfo } = params;
          if (!name || !voxelInfo) {
            return;
          }
          const skinPart = avatar.skinParts.get(name);
          if (!skinPart) {
            window.alert(`cannot find part ${name}`);
            return;
          }
          const { voxels, boundaryStart, originShape } = voxelInfo;

          const { meshes, texture } = await voxelsToMeshes(
            [voxels],
            palette,
            emissiveList,
          );
          skinPart.updateByMeshData({
            mesh: meshes[0],
            texture,
          });

          // 设置默认缩放
          vec3.set(
            skinPart.scale,
            BODY_PART_DEFAULT_SCALE,
            BODY_PART_DEFAULT_SCALE,
            BODY_PART_DEFAULT_SCALE,
          );

          // 与美术制定的规则：画布中心点正对骨骼节点
          // 将中心点移到原版vox画布的中心点
          vec3.scale(skinPart.pivot, originShape, -0.5);
          vec3.add(skinPart.pivot, skinPart.pivot, boundaryStart);
          vec3.scale(skinPart.pivot, skinPart.pivot, BODY_PART_DEFAULT_SCALE);

          // 设置默认旋转
          const euler = BODY_PART_DEFAULT_ROTATIONS[name];
          if (euler) {
            skinPart.setQuaternion(euler[0], euler[1], euler[2]);
          }
        },
      });
    },
    [avatar],
  );

  const loadSPData = useCallback((file: File, skinPart: SkinPart) => {
    const reader = new FileReader();
    reader.readAsArrayBuffer(file);
    reader.onload = () => {
      skinPart.updateByFileData(new Uint8Array(reader.result as ArrayBuffer));
    };
  }, []);

  const loadJSONData = useCallback((file: File, skinPart: SkinPart) => {
    const reader = new FileReader();
    reader.readAsText(file);
    reader.onload = async () => {
      const json = JSON.parse(reader.result as string);
      const result = await migrateJSON(json);
      if (!result) {
        return;
      }
      skinPart.updateByMeshData(result, result.bind);
    };
  }, []);

  const importVox = useMemo(() => {
    return (
      <div>
        <label className={style.fileLabel}>import vox</label>
        <input
          type="file"
          accept=".vox"
          onChange={async (ev) => {
            clearSkinParts();
            const files = ev.target.files;
            if (files) {
              const f = files[0];
              loadVoxData(f);
              ev.target.value = '';
            }
          }}
        />
      </div>
    );
  }, [loadVoxData, clearSkinParts]);

  const importAllSP = useMemo(() => {
    return (
      <div>
        <label className={style.fileLabel}>import all sp</label>
        <input
          type="file"
          accept=".sp"
          multiple={true}
          onChange={(ev) => {
            clearSkinParts();
            const files = ev.target.files;
            if (!files) {
              return;
            }

            for (let i = 0; i < files.length; i++) {
              const f = files[i];
              const name = f.name.split('.')[0];
              const currSkinPart = avatar?.skinParts.get(name);
              if (!currSkinPart) {
                continue;
              }
              loadSPData(f, currSkinPart);
            }

            ev.target.value = '';
          }}
        />
      </div>
    );
  }, [avatar, loadSPData, clearSkinParts]);

  const importAllJSON = useMemo(() => {
    return (
      <div>
        <label className={style.fileLabel}>import all json</label>
        <input
          type="file"
          accept=".json"
          multiple={true}
          onChange={(ev) => {
            clearSkinParts();
            const files = ev.target.files;
            if (!files) {
              return;
            }
            for (let i = 0; i < files.length; i++) {
              const f = files[i];
              const name = f.name.split('.')[0];
              const currSkinPart = avatar?.skinParts.get(name);
              if (!currSkinPart) {
                continue;
              }
              loadJSONData(f, currSkinPart);
            }

            ev.target.value = '';
          }}
        />
      </div>
    );
  }, [avatar, loadJSONData, clearSkinParts]);

  const exportVoxaContent = useMemo(() => {
    return (
      <label className={style.fileLabel} style={{ width: '100%' }}>
        皮肤voxa导出的工程文件hash值(projectFileHash)
        <Input
          type={'primary'}
          size={'middle'}
          valueType={'string'}
          value={voxaHash}
          onBlur={(value) => {
            setVoxaHash(value);
          }}
        />
      </label>
    );
  }, [voxaHash]);

  const exportVoxa = useMemo(() => {
    return (
      <div>
        <div className={style.title}>导出骨骼和皮肤的voxa工程文件</div>
        <button
          onClick={() => {
            setShowExportVoxa(true);
          }}
        >
          点击打开面板
        </button>
        {showExportVoxa && (
          <ModalView
            content={exportVoxaContent}
            onConfirm={async () => {
              if (!avatar) {
                return;
              }
              const res = await apis.modelContent.request({
                url: voxaHash,
                responseType: 'arraybuffer',
              });
              if (!res.data) {
                return;
              }
              const projectData = migrateProject(new Uint8Array(res.data));
              if (!projectData) {
                return;
              }

              exportVoxaProject(avatar.state, avatar.skinParts, projectData);
            }}
            onCancel={() => {
              setShowExportVoxa(false);
              setVoxaHash('');
            }}
          />
        )}
      </div>
    );
  }, [avatar, exportVoxaContent, showExportVoxa, voxaHash]);

  function importSkin() {
    return (
      <div>
        <div className={style.title}>导入皮肤</div>
        {importVox}
        {importAllSP}
        {importAllJSON}
      </div>
    );
  }

  function editSkin() {
    if (!skinPart) {
      return;
    }
    return (
      <div>
        <div className={style.title}>调整皮肤</div>
        <VectorInput
          key={'scale'}
          label={'scale'}
          lo={vec3.fromValues(0, 0, 0)}
          hi={vec3.fromValues(1, 1, 1)}
          value={scaleOffset}
          step={0.001}
          onChange={(value) => {
            setScaleOffset(value);
            vec3.copy(skinPart.scale, value);
          }}
        />
        <VectorInput
          key={'translate'}
          label={'translate'}
          lo={vec3.fromValues(-1, -1, -1)}
          hi={vec3.fromValues(1, 1, 1)}
          value={positionOffset}
          step={0.01}
          onChange={(value) => {
            setPositionOffset(value);
            skinPart.setPosition(value);
          }}
        />
        <VectorInput
          key={'rotate'}
          label={'rotate'}
          lo={vec3.fromValues(0, 0, 0)}
          hi={vec3.fromValues(360, 360, 360)}
          step={1}
          value={eulerOffset}
          onChange={(value) => {
            setEulerOffset(value);
            skinPart.setQuaternion(value[0], value[1], value[2]);
          }}
        />
      </div>
    );
  }

  const setBoneMeshVisible = useCallback(
    (visible: boolean) => {
      if (!avatar) {
        return;
      }

      avatar.skinParts.forEach((skinPart) => {
        const boneMesh = skinPart.parent?.children.find((obj) => obj.isMesh());
        boneMesh && (boneMesh.visible = visible);
      });
    },
    [avatar],
  );

  return (
    <div className={style.skinPanel}>
      <Button
        type="primary"
        onClick={async () => {
          if (!avatar) {
            return;
          }
          // 截图前，隐藏editor工具的骨骼
          setBoneMeshVisible(false);

          const pendingScreenshot = [
            ScreenshotMode.Suit,
            ScreenshotMode.Head,
            ScreenshotMode.Shirt,
            ScreenshotMode.Pants,
            ScreenshotMode.Shoes,
          ].map((mode) => {
            return avatar.getScreenshot(mode);
          });
          const [suit, head, shirt, pants, shoes] = await Promise.all(
            pendingScreenshot,
          );
          if (!suit || !head || !shirt || !pants || !shoes) {
            window.alert('screenshot error');
            return;
          }

          const saveSkins = Array.from(avatar.skinParts.values()).reduce(
            (prev, curr) => {
              prev[curr.name] = curr.getFileData();
              return prev;
            },
            {},
          );

          avatar.iframeTool.emitSaveEvent({
            skins: saveSkins as EmitEvents['save']['skins'],
            screenshot: {
              [SuitList.Suit]: suit,
              [SuitList.Head]: head,
              [SuitList.Shirt]: shirt,
              [SuitList.Pants]: pants,
              [SuitList.Shoes]: shoes,
            },
          });

          // 截图后，重新展示editor工具的骨骼
          setBoneMeshVisible(true);
        }}
      >
        保存
      </Button>
      <label className={style.label}>skin part</label>
      <select
        value={selectedSkinId}
        onChange={(ev) => {
          store.dispatch(setSelectedSkinId(ev.target.value));
        }}
      >
        {skinPartsOptions}
      </select>

      {skinPart && importSkin()}
      {skinPart && editSkin()}

      <div>
        <div className={style.title}>导出皮肤</div>
        {skinPart && (
          <div>
            <label className={style.label}>导出单个皮肤</label>
            <button
              onClick={() => {
                exportSkin(skinPart);
              }}
            >
              {`Export ${skinPart.name}`}
            </button>
          </div>
        )}

        <div>
          <label className={style.label}>导出所有皮肤</label>
          <button
            onClick={() => {
              const name = window.prompt('名字？');
              if (!name) {
                return;
              }
              avatar && exportSkinZip(avatar.skinParts, name);
            }}
          >
            Export zip
          </button>
        </div>
      </div>
      {clientConfig.appEnv !== 'production' && exportVoxa}
    </div>
  );
}
