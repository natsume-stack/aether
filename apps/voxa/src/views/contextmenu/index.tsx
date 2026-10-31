import { vec2 } from 'gl-matrix';
import { IntlShape, useIntl } from 'react-intl';
import React, {
  useMemo,
  useRef,
  useContext,
  useCallback,
  useEffect,
  ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDispatch } from 'react-redux';
import { Menu, SerializedVec2 } from '@box/box-design';

import { store, useAppSelector } from '../../redux/store';
import { AppMode, setContextmenu } from '../../redux/app-slice';
import { useEventListener } from '../hooks';
import { CLICK_OFFSET_THRESHOLD } from '../../models/editing/const';
import { VoxelEditor } from '../../models/editor';
import { VoxelEditorContext } from '../../internals';
import {
  AnimatorMode,
  NodeType,
  ProjectNodeType,
} from '../../redux/animator-slice';
import { getBoneIdBySkinId } from '../../models/animator-app/util';
import { LONG_PRESS_DURATION } from '../../defs';

export interface ContextmenuData {
  id: string;
  text: string;
}

export type OnContextMenuSelect = (id: string) => void;

export interface ContextMenuOptions {
  data: ContextmenuData[];
  position?: SerializedVec2;
  onSelect: (id: string) => void;
  onBlur: () => void;
  /**
   * 排列在menu组件下方。
   * 目前只有时间轴上的右键菜单需要传入，用于设置补帧方式
   */
  extra?: ReactNode;
  /**
   * 指定右键菜单的类名
   */
  className?: string;
}

export function ContextMenu(params: ContextMenuOptions) {
  const { data, position, onSelect, onBlur, extra, className } = params;

  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = menuRef.current;

    if (!element || !position) {
      return;
    }

    const { width, height } = element.getBoundingClientRect();

    const left =
      position[0] + width > window.innerWidth
        ? window.innerWidth - width
        : position[0];
    const top =
      position[1] + height > window.innerHeight
        ? window.innerHeight - height
        : position[1];

    Object.assign(element.style, {
      position: 'fixed',
      pointerEvents: 'initial',
      left: `${left}px`,
      top: `${top}px`,
    });
  }, [position]);

  // 选中菜单以外的位置时，使菜单消失
  useEventListener('click', (e) => {
    if (!(e.target instanceof Node) || !menuRef.current?.contains(e.target)) {
      onBlur();
    }
  });

  const onItemSelect = useCallback(
    (id) => {
      if (typeof id !== 'string') {
        return;
      }

      onSelect(id);
      onBlur();
    },
    [onSelect, onBlur],
  );

  const menu = (
    <Menu selectedItem="" items={data} onItemSelect={onItemSelect} />
  );

  return createPortal(
    <div
      ref={menuRef}
      className={className}
      style={{ position: 'fixed', zIndex: 11, outline: 'none' }}
    >
      {menu}
      {extra}
    </div>,
    document.body,
  );
}

type GlobalContextmenuOptions = Pick<ContextMenuOptions, 'data' | 'onSelect'>;

enum ContextmenuIds {
  // animator app
  /**
   * 创建部件
   */
  CreateObject = 'create-object',
  /**
   * 添加部件
   */
  AddObject = 'add-object',
  /**
   * 创建骨骼
   */
  CreateBone = 'create-bone',
  /**
   * 添加子骨骼
   */
  AddBone = 'add-bone',
  /**
   * 编辑部件
   */
  EditObject = 'edit-object',
  /**
   * 重命名部件
   */
  Rename = 'rename',
  /**
   * 常规复制部件/部件组
   */
  CopyAndPaste = 'copy-and-paste',
  /**
   * TODO: 控件复制，本次迭代不做
   */
  CopyAsComponent = 'copy-as-component',
  /**
   * 编组
   */
  GroupSelection = 'group-selection',
  /**
   * 解组
   */
  Ungroup = 'ungroup',
  /**
   * 删除部件/部件组
   */
  Delete = 'delete',
  /**
   * 解除部件绑定
   */
  Unbind = 'unbind',
}

/**
 * 监听舞台上的鼠标事件，判断是否展示右键菜单。
 * 因为舞台上右键可能会有其他操作（转动相机），所以做了特殊处理。
 */
export function useStageContextMenu(editor?: VoxelEditor) {
  const pointerDownTimeStamp = useRef<number>(0);

  const pointers = useRef<PointerEvent[]>([]);

  const dispatch = useDispatch();

  const { onPointerDown } = useMemo(() => {
    const isOutOfBounds = (event: PointerEvent) => {
      const pointerDownEvent = pointers.current.find(
        (pointer) => pointer.pointerId === event.pointerId,
      );
      if (!pointerDownEvent) {
        return false;
      }
      const delta = vec2.distance(
        [pointerDownEvent.clientX, pointerDownEvent.clientY],
        [event.clientX, event.clientY],
      );
      return delta >= CLICK_OFFSET_THRESHOLD;
    };

    const onPointerDown = (ev: PointerEvent) => {
      if (pointerDownTimeStamp.current > 0) {
        cancel();
      }

      // 右键响应
      if (
        editor &&
        ev.target === editor.stage.renderer.domElement &&
        (ev.button === 2 || ev.pointerType === 'touch')
      ) {
        pointers.current.push(ev);
        pointerDownTimeStamp.current = new Date().getTime();
        dispatch(setContextmenu({ visible: false }));
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        editor.animatorApp.nodeManager.addListener('dragStart', cancel);
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (pointerDownTimeStamp.current > 0 && isOutOfBounds(ev)) {
        cancel();
      }
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (pointerDownTimeStamp.current === 0) {
        return;
      }

      let visible = false;

      if (
        !isOutOfBounds(ev) &&
        editor &&
        ev.target === editor.stage.renderer.domElement
      ) {
        if (ev.pointerType === 'mouse') {
          visible = true;
        } else {
          visible =
            new Date().getTime() - pointerDownTimeStamp.current >=
            LONG_PRESS_DURATION;
        }
      }

      visible &&
        dispatch(
          setContextmenu({
            visible: true,
            position: [ev.clientX, ev.clientY],
          }),
        );

      cancel();
    };

    const cancel = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      editor?.animatorApp.nodeManager.removeListener('dragStart', cancel);

      pointers.current.length = 0;
      pointerDownTimeStamp.current = 0;
    };

    return { onPointerDown };
  }, [dispatch, editor]);

  useEventListener('pointerdown', onPointerDown);
}

/**
 * animator在使用全局的右键菜单。
 */
export function GlobalContextMenu() {
  const intl = useIntl();

  const editor = useContext(VoxelEditorContext);

  const mode = useAppSelector(({ app }) => app.mode);
  const position = useAppSelector(({ app }) => app.contextmenu.position);

  const params = useMemo(() => {
    // TODO 以后再增加voxel的右键菜单
    if (!editor || mode !== AppMode.Animator) {
      return;
    }

    return getAnimatorContextmenu(editor, intl);
  }, [editor, intl, mode]);

  const dispatch = useDispatch();

  const onBlur = useCallback(() => {
    dispatch(setContextmenu({ visible: false }));
  }, [dispatch]);

  if (!params || !params.data.length) {
    return null;
  }

  return (
    <ContextMenu
      data={params.data}
      onSelect={params.onSelect}
      onBlur={onBlur}
      position={position}
    />
  );
}

function getMenuState() {
  const { activeIds, hierarchyData } = store.getState().animator;
  const isSingle = (type: NodeType) => {
    return activeIds.length === 1 && hierarchyData[activeIds[0]]?.type === type;
  };

  const singleBone = isSingle(ProjectNodeType.Bone);
  const singleSkinPart = isSingle(ProjectNodeType.SkinPart);
  const singleGroup = isSingle(ProjectNodeType.Group);

  // 单选部件或部件组，且没有绑定骨骼，显示添加部件
  const showAddObject =
    (singleSkinPart || singleGroup) && !getBoneIdBySkinId(activeIds[0]);

  let showUnbind = true;
  let showGroup = true;
  let showUnGroup = true;

  activeIds.forEach((activeId) => {
    const node = hierarchyData[activeId];
    if (node.type === ProjectNodeType.Root) {
      return;
    }

    // 多选中出现骨骼，不显示编组/解组
    if (node.type === ProjectNodeType.Bone) {
      showGroup = false;
      showUnGroup = false;
      // 只要有一个骨骼没有绑定皮肤，就不显示解绑
      if (!node.skinId) {
        showUnbind = false;
      }
      return;
    }

    // 多选部件/部件组中，只要有一个绑定了骨骼，就不显示编组/解组
    if (node.boneId) {
      showGroup = false;
      showUnGroup = false;
    } else {
      // 多选部件/部件组中，只要有一个没有绑定骨骼，就不显示解绑
      showUnbind = false;
    }
    // 多选部件/部件组中，只要有一个是部件，就不显示解组
    if (node.type === ProjectNodeType.SkinPart) {
      showUnGroup = false;
    }
  });
  return {
    /**
     * 单选骨骼
     */
    singleBone,
    /**
     * 单选部件
     */
    singleSkinPart,
    /**
     * 单选部件组
     */
    singleGroup,
    /**
     * 显示解绑按钮
     */
    showUnbind,
    /**
     * 显示编组按钮
     */
    showGroup,
    /**
     * 显示解组按钮
     */
    showUnGroup,
    /**
     * 显示添加部件
     */
    showAddObject,
  };
}

function getOnSelect(editor: VoxelEditor) {
  const { activeIds, activeSkinPartIds } = store.getState().animator;
  return (id: string) => {
    switch (id) {
      case ContextmenuIds.CreateObject:
        editor.animatorApp.nodeManager.addSkinPart();
        break;
      case ContextmenuIds.AddObject:
        editor.animatorApp.nodeManager.addSkinPart({
          selectedId: activeIds[0],
        });
        break;
      case ContextmenuIds.CreateBone:
        editor.animatorApp.nodeManager.addBone();
        break;
      case ContextmenuIds.AddBone:
        editor.animatorApp.nodeManager.addBone(activeIds[0]);
        break;
      case ContextmenuIds.EditObject:
        editor.switchToVoxel(activeSkinPartIds[0]);
        break;
      case ContextmenuIds.Rename:
        editor.animatorApp.nodeManager.setEditingNodeId(activeIds[0]);
        break;
      case ContextmenuIds.CopyAndPaste:
        editor.animatorApp.nodeManager.copyNodes(activeIds);
        break;
      case ContextmenuIds.CopyAsComponent:
        // TODO: 控件复制
        break;
      case ContextmenuIds.GroupSelection:
        editor.animatorApp.nodeManager.addGroup(activeIds);
        break;
      case ContextmenuIds.Ungroup:
        // TODO: 批量解组撤销重做需要打组，最好封装在animator方法中
        activeIds.forEach((id) => {
          editor.animatorApp.nodeManager.releaseGroup(id);
        });
        break;
      case ContextmenuIds.Delete:
        editor.animatorApp.nodeManager.removeNodes(activeIds);
        break;
      case ContextmenuIds.Unbind:
        editor.animatorApp.nodeManager.unbindNodes(activeIds, true);
        break;
    }
  };
}

function getAnimatorContextmenu(
  editor: VoxelEditor,
  intl: IntlShape,
): GlobalContextmenuOptions {
  const { activeIds, pivotMode, mode } = store.getState().animator;

  // 中心点模式/物理碰撞框编辑禁用右键菜单
  if (pivotMode || mode === AnimatorMode.HitBox) {
    return {
      data: [],
      onSelect() {},
    };
  }
  const {
    singleBone,
    singleSkinPart,
    showUnbind,
    showGroup,
    showUnGroup,
    showAddObject,
  } = getMenuState();
  const contextmenuData: ContextmenuData[] = [];
  const onSelect = getOnSelect(editor);

  const rename: ContextmenuData = {
    id: ContextmenuIds.Rename,
    text: intl.formatMessage({
      description: 'Contextmenu rename object or bone',
      defaultMessage: 'Rename',
    }),
  };

  // 动画模式下，只能对单个节点进行重命名
  // 动画模式下，禁用部件交互
  if (mode === AnimatorMode.Motion) {
    if (singleBone) {
      contextmenuData.push(rename);
    }
    return { data: contextmenuData, onSelect };
  }

  // 空选，显示创建部件和创建骨骼按钮
  if (!activeIds.length) {
    contextmenuData.push({
      id: ContextmenuIds.CreateObject,
      text: intl.formatMessage({
        description: 'Contextmenu create object',
        defaultMessage: 'Create object',
      }),
    });

    contextmenuData.push({
      id: ContextmenuIds.CreateBone,
      text: intl.formatMessage({
        description: 'Contextmenu create bone',
        defaultMessage: 'Create bone',
      }),
    });
    return { data: contextmenuData, onSelect };
  }

  // 单选未绑定骨骼的部件/部件组，显示添加部件按钮
  if (showAddObject) {
    contextmenuData.push({
      id: ContextmenuIds.AddObject,
      text: intl.formatMessage({
        description: 'Contextmenu add object',
        defaultMessage: 'Add object',
      }),
    });
  }

  // 单选部件，显示编辑部件按键
  if (singleSkinPart) {
    contextmenuData.push({
      id: ContextmenuIds.EditObject,
      text: intl.formatMessage({
        description: 'Contextmenu edit object',
        defaultMessage: 'Edit object',
      }),
    });
  }

  // 单选骨骼，显示添加子骨骼按钮
  if (singleBone) {
    contextmenuData.push({
      id: ContextmenuIds.AddBone,
      text: intl.formatMessage({
        description: 'Contextmenu add child bone node',
        defaultMessage: 'Add node',
      }),
    });
  }

  // 只要当前有选中的部件/部件组/骨骼，显示复制按钮
  if (activeIds.length) {
    contextmenuData.push({
      id: ContextmenuIds.CopyAndPaste,
      text: intl.formatMessage({
        description: 'Contextmenu make a copy',
        defaultMessage: 'Make a copy',
      }),
    });
  }

  // 单选/多选有绑定部件的骨骼，显示解绑按钮
  if (showUnbind) {
    contextmenuData.push({
      id: ContextmenuIds.Unbind,
      text: intl.formatMessage({
        description: 'Contextmenu unbind object',
        defaultMessage: 'Unbound',
      }),
    });
  }

  // 单选部件/部件组/骨骼，显示重命名按钮
  if (activeIds.length === 1) {
    contextmenuData.push(rename);
  }

  // 单选部件/部件组；混选部件和部件组，显示编组按键
  // 不包含被绑定的部件/部件组
  if (showGroup) {
    contextmenuData.push({
      id: ContextmenuIds.GroupSelection,
      text: intl.formatMessage({
        description: 'Contextmenu group selection',
        defaultMessage: 'Group selection',
      }),
    });
  }

  // 单选/多选部件组，显示解组按键
  // 不包含被绑定的部件/部件组
  if (showUnGroup) {
    contextmenuData.push({
      id: ContextmenuIds.Ungroup,
      text: intl.formatMessage({
        description: 'Contextmenu ungroup',
        defaultMessage: 'Ungroup',
      }),
    });
  }

  // 只要当前有选中的部件/部件组/骨骼，显示删除按键
  if (activeIds.length) {
    contextmenuData.push({
      id: ContextmenuIds.Delete,
      text: intl.formatMessage({
        description: 'Contextmenu delete',
        defaultMessage: 'Delete',
      }),
    });
  }

  return { data: contextmenuData, onSelect };
}
