import { IntlShape } from 'react-intl';
import { IconAddObject, IconAddObjectPic, IconSize } from '@box/icons';
import {
  AddType,
  AnimatorMode,
  AnimatorState,
  HitBoxMode,
  PivotMode,
  setAddType,
  ToolType,
} from '../../redux/animator-slice';
import { AppMode, EditType } from '../../redux/app-slice';
import { Actions, colorSelectOptions, EditingMode } from '@box/utils/helper';
import type {
  MenuItemOptions,
  ToolItemOptions,
  VideoMedia,
} from '@box/box-design';
import { VoxelDimension } from '../../models/project/defs';
import { store } from '../../redux/store';
import type { VoxelEditor } from '../../models/editor';
import videoMove from './assets/move.mp4';
import videoMarqueeSelect from './assets/marquee-select.mp4';
import videoVoxelSelect from './assets/voxel-select.mp4';
import videoMagicWand from './assets/magic-wand.mp4';
import videoBuildVoxel from './assets/build-voxel.mp4';
import videoEraseVoxel from './assets/erase-voxel.mp4';
import videoBuildBox from './assets/build-box.mp4';
import videoEraseBox from './assets/erase-box.mp4';
import videoExtrude from './assets/extrude.mp4';
import videoPainter from './assets/painter.mp4';
import videoPaintBucket from './assets/paint-bucket.mp4';
import videoColorPicker from './assets/color-picker.mp4';
import videoObjectCreate from './assets/object-create.mp4';
import videoObjectCopy from './assets/object-make-a-copy.mp4';
import videoObjectRotate from './assets/object-rotate.mp4';
import videoObjectMove from './assets/object-move.mp4';
import videoBoneCreate from './assets/bone-create.mp4';

/**
 * 生成侧边栏菜单的选项参数。
 * 不同工具参数不同。
 */
export type MenuOptions = {
  /**
   * 工具模式
   */
  type: AppMode;

  /**
   * 是否是中心点模式
   */
  pivotMode: PivotMode;

  /**
   * 新增组件类型，3D or 2D
   */
  addType: AddType;

  /**
   * 多部件模式
   */
  animatorMode: AnimatorMode;

  /**
   * 物理碰撞框模式
   */
  hitBoxMode: HitBoxMode;

  /**
   * editor模块，需要调用内部的组件。
   */
  editor: VoxelEditor;
  /**
   * i18n模块
   */
  intl: IntlShape;
  /**
   * 当前编辑模式：普通模式、皮肤模式, 默认普通模式
   */
  editType?: EditType;
};

enum MenuIds {
  // voxel app
  VoxelTranslate = 'voxel-translate',
  Select = 'select',
  MarqueeSelect = 'marquee-select',
  VoxelSelect = 'voxel-select',
  MagicWand = 'magic-wand',
  AttachBox = 'attach-box',
  AttachLine = 'attach-line',
  EraseBox = 'erase-box',
  EraseLine = 'erase-line',
  Painter = 'painter',
  PaintBucket = 'paint-bucket',
  ColorPicker = 'color-picker',
  Extrude = 'extrude',

  // animator app
  AddObject = 'add-object',
  AddObject3D = 'add-object3d',
  AddObject2D = 'add-object2d',
  CopyObject = 'copy-object',
  AnimatorTranslate = 'animator-translate',
  AnimatorRotation = 'animator-rotation',
  AnimatorScale = 'animator-scale',
  AddBone = 'add-bone',
}

export function getMenuData(options: MenuOptions) {
  if (options.type === AppMode.Voxel) {
    return getVoxelEditorMenu(options);
  }

  return getAnimatorMenu(options);
}

export type OnTrigger = () => (() => void) | void;

interface MenuData extends ToolItemOptions {
  menu?: (MenuItemOptions & { onTrigger?: OnTrigger })[];
  onTrigger?: OnTrigger;
}

export const GAP: 'gap' = 'gap';

const VIDEO_OPTIONS: Omit<VideoMedia, 'src'> = {
  type: 'video',
  loopGap: 1000,
  playbackRate: 0.9,
};

function getAnimatorMenu(options: MenuOptions): (MenuData | typeof GAP)[] {
  const {
    editor,
    pivotMode,
    addType,
    animatorMode,
    hitBoxMode,
    intl,
    editType,
  } = options;

  const isPivotMode = pivotMode !== PivotMode.None;

  const toolDisabled =
    isPivotMode ||
    (animatorMode === AnimatorMode.HitBox && hitBoxMode === HitBoxMode.Default);

  const menu: (MenuData | typeof GAP)[] = [];
  menu.push({
    id: MenuIds.AnimatorTranslate,
    icon: '#icon-tool-move',
    disabled: toolDisabled,
    onTrigger: () => editor.animatorApp.setToolType(ToolType.Translate),
    tooltip: {
      title: intl.formatMessage({
        description: 'Animator tool move title',
        defaultMessage: 'Move',
      }),
      text: intl.formatMessage({
        description: 'Animator tool move description',
        defaultMessage: 'Move object(s) in X/Y/Z-axis',
      }),
      media: {
        ...VIDEO_OPTIONS,
        src: videoObjectMove,
      },
    },
  });

  if (animatorMode !== AnimatorMode.HitBox) {
    menu.push({
      id: MenuIds.AnimatorRotation,
      icon: '#icon-tool-rotate',
      disabled: toolDisabled,
      onTrigger: () => editor.animatorApp.setToolType(ToolType.Rotate),
      tooltip: {
        title: intl.formatMessage({
          description: 'Animator tool rotate title',
          defaultMessage: 'Rotate',
        }),
        text: intl.formatMessage({
          description: 'Animator tool rotate description',
          defaultMessage: 'Rotate object(s) around X/Y/Z-axis',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoObjectRotate,
        },
      },
    });
  }

  menu.push({
    id: MenuIds.AnimatorScale,
    icon: (
      <IconSize
        style={{
          fill: 'url(#fill-icon-linear-gradient)',
        }}
      />
    ),
    disabled: toolDisabled,
    onTrigger: () => editor.animatorApp.setToolType(ToolType.Scale),
    tooltip: {
      title: intl.formatMessage({
        description: 'Animator tool scale title',
        defaultMessage: 'Scale',
      }),
      text: intl.formatMessage({
        description: 'Animator tool scale description',
        defaultMessage: 'Scale the size of the selected object, bone',
      }),
    },
  });

  if (animatorMode === AnimatorMode.Setup) {
    menu.push(
      GAP,
      {
        id: MenuIds.AddObject,
        icon: '#',
        menu: [
          {
            id: MenuIds.AddObject3D,
            icon: <IconAddObject />,
            text: intl.formatMessage({
              description: 'Animator tool add object 3D',
              defaultMessage: 'Create object',
            }),
            onTrigger: () => {
              store.dispatch(setAddType('object3d'));
            },
          },
          {
            id: MenuIds.AddObject2D,
            icon: <IconAddObjectPic />,
            text: intl.formatMessage({
              description: 'Animator tool add object 2D',
              defaultMessage: 'Create picture object',
            }),
            onTrigger: () => {
              store.dispatch(setAddType('object2d'));
            },
          },
        ],
        disabled: isPivotMode,
        onItemClick: (id) => {
          editor.animatorApp.nodeManager.addSkinPart({
            dimension:
              id === MenuIds.AddObject3D
                ? VoxelDimension.XYZ
                : VoxelDimension.XY,
          });
        },
        selectedItem:
          addType === 'object3d' ? MenuIds.AddObject3D : MenuIds.AddObject2D,
        tooltip: {
          title: intl.formatMessage({
            description: 'Animator tool create title',
            defaultMessage: 'Create',
          }),
          text: intl.formatMessage({
            description: 'Animator tool create description',
            defaultMessage: 'Create a new object',
          }),
          media: {
            ...VIDEO_OPTIONS,
            src: videoObjectCreate,
          },
        },
      },
      {
        id: MenuIds.CopyObject,
        icon: '#icon-tool-copy',
        disabled: isPivotMode,
        onItemClick: () => {
          editor.animatorApp.nodeManager.copyNodes();
        },
        tooltip: {
          title: intl.formatMessage({
            description: 'Animator tool make a copy title',
            defaultMessage: 'Make a Copy',
          }),
          text: intl.formatMessage({
            description: 'Animator tool make a copy description',
            defaultMessage: 'Make a copy of the selection',
          }),
          media: {
            ...VIDEO_OPTIONS,
            src: videoObjectCopy,
          },
        },
      },
    );
    if (editType !== EditType.Skin) {
      menu.push(GAP, {
        id: MenuIds.AddBone,
        icon: '#icon-tool-joint-tool',
        disabled: isPivotMode,
        onItemClick: () => {
          editor.animatorApp.nodeManager.addBone();
        },
        tooltip: {
          title: intl.formatMessage({
            description: 'Animator tool add bone title',
            defaultMessage: 'Create Bone',
          }),
          text: intl.formatMessage({
            description: 'Animator tool add bone description',
            defaultMessage: 'Create a new bone',
          }),
          media: {
            ...VIDEO_OPTIONS,
            src: videoBoneCreate,
          },
        },
      });
    }
  }
  return menu;
}

function getVoxelEditorMenu(options: {
  /**
   * editor模块，需要调用内部的组件。
   */
  editor: VoxelEditor;
  intl: IntlShape;
}): (MenuData | typeof GAP)[] {
  const { intl } = options;
  const { voxelApp } = options.editor;
  const { veState } = voxelApp;

  function setSelection(mode: EditingMode.voxel | EditingMode.rect) {
    voxelApp.setTool({
      toolType: Actions.Select,
      mode,
    });
  }

  function setMagicWand() {
    voxelApp.setTool({
      toolType: Actions.ColorSelect,
    });

    veState.setColorSelectOption(colorSelectOptions.volume);
  }

  function setTranslation() {
    voxelApp.setTool({
      toolType: Actions.Translate,
    });
    voxelApp.translateTool.enable();

    return () => {
      voxelApp.translateTool.disable();
    };
  }

  function setAttach(mode: EditingMode.line | EditingMode.box) {
    voxelApp.setTool({
      toolType: Actions.Attach,
      mode,
    });
  }

  function setEraser(mode: EditingMode.line | EditingMode.box) {
    voxelApp.setTool({
      toolType: Actions.Erase,
      mode,
    });
  }

  function setBrush() {
    voxelApp.setTool({ toolType: Actions.Paint });
  }

  function setBucket() {
    voxelApp.setTool({
      toolType: Actions.FillSameColorSpace,
    });
  }

  function setColorPicker() {
    voxelApp.setTool({
      toolType: Actions.PickColor,
    });
  }

  const marqueeSelectText = intl.formatMessage({
    description: 'toolSelectRect',
    defaultMessage: 'Marquee Select',
  });

  const voxelSelectText = intl.formatMessage({
    description: 'toolSelectVoxel',
    defaultMessage: 'Voxel Select',
  });

  return [
    {
      id: MenuIds.VoxelTranslate,
      icon: '#icon-tool-move',
      onTrigger: setTranslation,
      tooltip: {
        title: intl.formatMessage({
          description: 'toolMoveTitle',
          defaultMessage: 'Move',
        }),
        text: intl.formatMessage({
          description: 'toolMoveDescription',
          defaultMessage: 'Move voxels in X/Y/Z-axis',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoMove,
        },
      },
    },
    {
      id: MenuIds.Select,
      icon: '#',
      menu: [
        {
          id: MenuIds.MarqueeSelect,
          icon: '#icon-tool-select',
          text: marqueeSelectText,
          onTrigger: () => {
            setSelection(EditingMode.rect);

            voxelApp.pointer.setDrawingEnabled(false);

            return () => {
              voxelApp.pointer.setDrawingEnabled(true);
            };
          },
        },
        {
          id: MenuIds.VoxelSelect,
          icon: '#icon-tool-select-box',
          text: voxelSelectText,
          onTrigger: () => setSelection(EditingMode.voxel),
        },
      ],
      tooltip: (id) => {
        if (id === MenuIds.MarqueeSelect) {
          return {
            title: marqueeSelectText,
            text: intl.formatMessage({
              description: 'toolSelectRectDescription',
              defaultMessage: 'Select target area',
            }),
            media: {
              ...VIDEO_OPTIONS,
              src: videoMarqueeSelect,
            },
          };
        } else {
          return {
            title: voxelSelectText,
            text: intl.formatMessage({
              description: 'toolSelectVoxelDescription',
              defaultMessage: 'Select target voxels',
            }),
            media: {
              ...VIDEO_OPTIONS,
              src: videoVoxelSelect,
            },
          };
        }
      },
    },
    {
      id: MenuIds.MagicWand,
      icon: '#icon-tool-magicwand',
      onTrigger: setMagicWand,
      tooltip: {
        title: intl.formatMessage({
          description: 'toolMagicWand',
          defaultMessage: 'Magic Wand',
        }),
        text: intl.formatMessage({
          description: 'toolMagicWandDescription',
          defaultMessage: 'Select voxels in same color based on volume',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoMagicWand,
        },
      },
    },
    GAP,
    {
      id: MenuIds.AttachLine,
      icon: '#icon-tool-add-voxel',
      onTrigger: () => setAttach(EditingMode.line),
      tooltip: {
        title: intl.formatMessage({
          description: 'toolAttachVoxel',
          defaultMessage: 'Build Voxel',
        }),
        text: intl.formatMessage({
          description: 'toolAttachVoxelDescription',
          defaultMessage: 'Build voxels by clicking or click-and-drag',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoBuildVoxel,
        },
      },
    },
    {
      id: MenuIds.EraseLine,
      icon: '#icon-tool-delete-voxel',
      onTrigger: () => setEraser(EditingMode.line),
      tooltip: {
        title: intl.formatMessage({
          description: 'toolEraseVoxel',
          defaultMessage: 'Erase Voxel',
        }),
        text: intl.formatMessage({
          description: 'toolEraseVoxelDescription',
          defaultMessage: 'Erase voxels by clicking or click-and-drag',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoEraseVoxel,
        },
      },
    },
    {
      id: MenuIds.AttachBox,
      icon: '#icon-tool-add-box',
      onTrigger: () => setAttach(EditingMode.box),
      tooltip: {
        title: intl.formatMessage({
          description: 'toolAttachBox',
          defaultMessage: 'Build Box',
        }),
        text: intl.formatMessage({
          description: 'toolAttachBoxDescription',
          defaultMessage: 'Build voxels by box',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoBuildBox,
        },
      },
    },
    {
      id: MenuIds.EraseBox,
      icon: '#icon-tool-delete-box',
      onTrigger: () => setEraser(EditingMode.box),
      tooltip: {
        title: intl.formatMessage({
          description: 'toolEraseBox',
          defaultMessage: 'Erase Box',
        }),
        text: intl.formatMessage({
          description: 'toolEraseBoxDescription',
          defaultMessage: 'Erase voxels by box',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoEraseBox,
        },
      },
    },
    {
      id: MenuIds.Extrude,
      icon: '#icon-tool-extrude',
      onTrigger: () => {
        voxelApp.setTool({
          toolType: Actions.Extrude,
        });
      },
      tooltip: {
        title: intl.formatMessage({
          description: 'toolExtrude',
          defaultMessage: 'Extrude',
        }),
        text: intl.formatMessage({
          description: 'toolExtrudeDescription',
          defaultMessage: 'Modify the height of voxel volume',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoExtrude,
        },
      },
    },
    GAP,
    {
      id: MenuIds.Painter,
      icon: '#icon-tool-brush',
      onTrigger: setBrush,
      tooltip: {
        title: intl.formatMessage({
          description: 'toolPainter',
          defaultMessage: 'Paint Brush',
        }),
        text: intl.formatMessage({
          description: 'toolPainterDescription',
          defaultMessage: 'Paint color by clicking or click-and-drag',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoPainter,
        },
      },
    },
    {
      id: MenuIds.PaintBucket,
      icon: '#icon-tool-bucket',
      onTrigger: setBucket,
      tooltip: {
        title: intl.formatMessage({
          description: 'toolPaintBucket',
          defaultMessage: 'Paint Bucket',
        }),
        text: intl.formatMessage({
          description: 'toolPaintBucketDescription',
          defaultMessage: 'Paint contiguous voxels with same color',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoPaintBucket,
        },
      },
    },
    {
      id: MenuIds.ColorPicker,
      icon: '#icon-tool-eyedropper',
      onTrigger: setColorPicker,
      tooltip: {
        title: intl.formatMessage({
          description: 'toolColorPicker',
          defaultMessage: 'Color Picker',
        }),
        text: intl.formatMessage({
          description: 'toolColorPickerDescription',
          defaultMessage: 'Pick the color from a voxel',
        }),
        media: {
          ...VIDEO_OPTIONS,
          src: videoColorPicker,
        },
      },
    },
  ];
}

export function animatorStateToSection(
  animatorState: AnimatorState,
): string | undefined {
  const { toolType } = animatorState;
  switch (toolType) {
    case ToolType.Translate:
      return MenuIds.AnimatorTranslate;
    case ToolType.Rotate:
      return MenuIds.AnimatorRotation;
    case ToolType.Scale:
      return MenuIds.AnimatorScale;
  }
}

/**
 * 把state中的编辑数据转换成对应的菜单id
 */
export function editingStateToSelection(options: {
  mode: EditingMode;
  toolType: Actions;
}): string | undefined {
  const { mode, toolType } = options;

  switch (toolType) {
    case Actions.Select:
      return mode === EditingMode.voxel
        ? MenuIds.VoxelSelect
        : MenuIds.MarqueeSelect;
    case Actions.ColorSelect:
      return MenuIds.MagicWand;
    case Actions.Translate:
      return MenuIds.VoxelTranslate;
    case Actions.Attach:
      return mode === EditingMode.box ? MenuIds.AttachBox : MenuIds.AttachLine;
    case Actions.Erase:
      return mode === EditingMode.box ? MenuIds.EraseBox : MenuIds.EraseLine;
    case Actions.Paint:
      return MenuIds.Painter;
    case Actions.FillSameColorSpace:
      return MenuIds.PaintBucket;
    case Actions.PickColor:
      return MenuIds.ColorPicker;
    case Actions.Extrude:
      return MenuIds.Extrude;
  }
}
