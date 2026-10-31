import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import { useDispatch } from 'react-redux';
import { vec2 } from 'gl-matrix';
import {
  CollapsePanel,
  TooltipTrigger,
  SelectType,
  TreeNodeType,
  TooltipTriggerOptions,
  DraggingItem,
  DropTarget,
  DropType,
  Tree,
  TreeHandle,
  TreeNode,
} from '@box/box-design';
import styles from './style.module.scss';
import { useAppSelector } from '../../redux/store';
import {
  AnimatorMode,
  HierarchyNode,
  setExpandedIds,
  ProjectNodeType,
} from '../../redux/animator-slice';
import { VoxelEditorContext } from '../../internals';
import { EditType, setContextmenu } from '../../redux/app-slice';
import {
  getNodeDescendants,
  getRootParentId,
  getTopSelectedId,
} from '../../models/animator-app/util';
import { useDragAbort } from '../hooks';
import {
  LONG_PRESS_DURATION,
  MAX_STRING_LENGTH,
  ROOT_BONE_ID,
  ROOT_SKIN_ID,
} from '../../defs';
import { CLICK_OFFSET_THRESHOLD } from '../../models/editing/const';
import { isMobile } from '../../utils/devices';

type HierarchyProps = {
  panelId: number;
  height: string;
};

enum Pointer {
  None,
  DragBone,
  DragSkin,
  BindSkin,
  ReplaceSkin,
  NotAllowed,
}

export function Hierarchy(props: HierarchyProps) {
  const intl = useIntl();

  const {
    hierarchyData,
    activeIds,
    mode,
    editingNodeId,
    expandedIds,
    editType,
    pivotMode,
  } = useAppSelector((state) => ({
    hierarchyData: state.animator.hierarchyData,
    activeIds: state.animator.activeIds,
    mode: state.animator.mode,
    editingNodeId: state.animator.editingNodeId,
    expandedIds: state.animator.expandedIds,
    editType: state.app.editType,
    pivotMode: state.animator.pivotMode,
  }));
  const editor = useContext(VoxelEditorContext);

  const treeRef = useRef<TreeHandle>(null);

  const getTreeNodeIcon = useCallback((hierarchyNode: HierarchyNode) => {
    if (
      hierarchyNode.type === ProjectNodeType.Bone &&
      hierarchyNode.id !== ROOT_BONE_ID
    ) {
      return '#icon-tool-joint-tool';
    }
    if (hierarchyNode.type === ProjectNodeType.Group) {
      return '#icon-list-group';
    }
    if (hierarchyNode.type === ProjectNodeType.SkinPart) {
      return '#icon-list-object';
    }
  }, []);

  const skinPartsInteractive = useMemo(
    () => mode !== AnimatorMode.Motion,
    [mode],
  );
  const boneInteractive = useMemo(
    () => editType !== EditType.Skin && !pivotMode,
    [pivotMode, editType],
  );

  const getTreeNode = useCallback(
    (hierarchyNode: HierarchyNode): TreeNode => {
      const type =
        hierarchyNode.type === ProjectNodeType.Bone
          ? hierarchyNode.id === ROOT_BONE_ID
            ? TreeNodeType.Root
            : TreeNodeType.Attachable
          : TreeNodeType.Basic;
      const icon = getTreeNodeIcon(hierarchyNode);
      const children: TreeNode[] = [];
      if (hierarchyNode.childrenIds) {
        hierarchyNode.childrenIds.forEach((id) => {
          children.push(getTreeNode(hierarchyData[id]));
        });
      }

      const classNames: string[] = [];
      let nodeInteractive = true;
      if (type === TreeNodeType.Root) {
        classNames.push(styles.rootNode);
      }
      // 骨骼不可交互时添加boneNodeUnselected
      if (
        hierarchyNode.type === ProjectNodeType.Bone &&
        hierarchyNode.id !== ROOT_BONE_ID &&
        !boneInteractive
      ) {
        classNames.push(styles.boneNodeUnselected);
        nodeInteractive = false;
      }
      // 部件不可交互时添加 skinPartNodeUnselected
      if (
        (hierarchyNode.type === ProjectNodeType.SkinPart ||
          hierarchyNode.type === ProjectNodeType.Group) &&
        !skinPartsInteractive
      ) {
        classNames.push(styles.skinPartNodeUnselected);
        nodeInteractive = false;
      }

      return {
        id: hierarchyNode.id,
        type: type,
        name: hierarchyNode.name,
        attachedNode:
          hierarchyNode.type === ProjectNodeType.Bone && hierarchyNode.skinId
            ? getTreeNode(hierarchyData[hierarchyNode.skinId])
            : undefined,
        children: hierarchyNode.childrenIds ? children : undefined,
        icon: icon,
        separator: hierarchyNode.id === ROOT_BONE_ID,
        disableExpand:
          hierarchyNode.id === ROOT_BONE_ID ||
          hierarchyNode.id === ROOT_SKIN_ID,
        className: classNames.join(' '),
        invisible: hierarchyNode.id === ROOT_SKIN_ID,
        disableRename: !nodeInteractive,
        disableHover: !nodeInteractive,
        disableDragging: !nodeInteractive,
      };
    },
    [boneInteractive, skinPartsInteractive, getTreeNodeIcon, hierarchyData],
  );

  const treeData = useMemo(() => {
    const boneTree = getTreeNode(hierarchyData[ROOT_BONE_ID]);
    const skinTree = getTreeNode(hierarchyData[ROOT_SKIN_ID]);

    return [boneTree, skinTree];
  }, [getTreeNode, hierarchyData]);

  const dispatch = useDispatch();

  // 正在拖拽的对象
  const [draggingItem, setDraggingItem] = useState(DraggingItem.None);
  // 光标样式，由draggingItem和当前光标hover对象共同决定
  const [pointer, setPointer] = useState(Pointer.None);
  const [className, setClassName] = useState(styles.hierarchy);

  useEffect(() => {
    let pointerStyle = '';
    switch (pointer) {
      case Pointer.DragBone:
        pointerStyle = styles.dragBone;
        break;
      case Pointer.DragSkin:
        pointerStyle = styles.dragSkin;
        break;
      case Pointer.BindSkin:
        pointerStyle = styles.bindSkin;
        break;
      case Pointer.ReplaceSkin:
        pointerStyle = styles.replaceSkin;
        break;
      case Pointer.NotAllowed:
        pointerStyle = styles.notAllowed;
        break;
    }
    setClassName([styles.hierarchy, pointerStyle].join(' '));
  }, [pointer]);

  const abortRef = useRef(() => {});

  const onAbort = useCallback(() => {
    // tree内部的中断处理
    abortRef.current();

    setDraggingItem(DraggingItem.None);
    setPointer(Pointer.None);
    setTooltipVisible(false);
  }, []);

  const { dragStart, dragEnd, abortRef: dragAbortRef } = useDragAbort();

  dragAbortRef.current = onAbort;

  const onBoneNotInteractive = useCallback(
    (ids, selectType) => {
      if (!editor) {
        return;
      }
      switch (selectType) {
        // 单选和点按多选过滤骨骼节点
        case SelectType.Single: {
          // 单选选择骨骼时，没有任何交互
          if (hierarchyData[ids[0]].type === ProjectNodeType.Bone) {
            break;
          }
        }
        case SelectType.Multi: {
          const selectedIds = ids.filter(
            (id) => hierarchyData[id].type !== ProjectNodeType.Bone,
          );
          editor.animatorApp.nodeManager.setActiveIds(selectedIds);
          break;
        }

        // shift 序列多选过滤骨骼节点，添加骨骼绑定的部件
        case SelectType.Sequence: {
          /**
           * 序列多选时，可能存在重复的id
           * 比如最后选的节点是一个绑定在骨骼上的皮肤，那么皮肤会出现在ids中，又会被作为骨骼蒙皮（node.skinId）解析出来
           */
          const selectedIds = new Set<string>();

          ids.forEach((id) => {
            const node = hierarchyData[id];

            if (node.type !== ProjectNodeType.Bone) {
              selectedIds.add(id);

              return;
            }

            if (node.skinId) {
              selectedIds.add(node.skinId);
            }
          });

          editor.animatorApp.nodeManager.setActiveIds(Array.from(selectedIds));
          break;
        }
      }
    },
    [editor, hierarchyData],
  );

  const onSkinPartNotInteractive = useCallback(
    (ids, selectType) => {
      if (!editor) {
        return;
      }
      switch (selectType) {
        // 单选和点按多选过滤部件节点
        case SelectType.Single: {
          // 单选选择部件时，没有任何交互
          if (hierarchyData[ids[0]].type !== ProjectNodeType.Bone) {
            break;
          }
        }
        case SelectType.Multi: {
          const selectedIds = ids.filter(
            (id) => hierarchyData[id].type === ProjectNodeType.Bone,
          );
          editor.animatorApp.nodeManager.setActiveIds(selectedIds);
          break;
        }

        // shift 序列多选过滤部件节点
        case SelectType.Sequence: {
          /**
           * 序列多选时，可能存在重复的id
           */
          const selectedIds = new Set<string>();

          ids.forEach((id) => {
            const node = hierarchyData[id];
            if (node.type === ProjectNodeType.Bone) {
              selectedIds.add(id);
            }
          });

          editor.animatorApp.nodeManager.setActiveIds(Array.from(selectedIds));
          break;
        }
      }
    },
    [editor, hierarchyData],
  );

  const onSelect = useCallback(
    (ids, selectType) => {
      dispatch(
        setContextmenu({
          visible: false,
        }),
      );
      if (!editor) {
        return;
      }

      // 骨骼不可交互
      if (!boneInteractive) {
        onBoneNotInteractive(ids, selectType);
        return;
      }

      // 全选骨骼的处理
      const rootBoneIndex = ids.indexOf(ROOT_BONE_ID);
      if (rootBoneIndex > -1) {
        ids.splice(rootBoneIndex, 1);
        ids.push(...getNodeDescendants(ROOT_BONE_ID));
      }

      // 部件不可交互
      if (!skinPartsInteractive) {
        onSkinPartNotInteractive(ids, selectType);
        return;
      }

      editor.animatorApp.nodeManager.setActiveIds(ids);
    },
    [
      dispatch,
      editor,
      skinPartsInteractive,
      boneInteractive,
      onBoneNotInteractive,
      onSkinPartNotInteractive,
    ],
  );

  const onDragStart = useCallback(
    (ev: React.MouseEvent, draggingItem: DraggingItem) => {
      if (!activeIds.length) {
        return;
      }

      dragStart();

      if (mode === AnimatorMode.Motion) {
        setDraggingItem(DraggingItem.NotAllowed);
        setTooltipVisible(true);
        setCursorPosition([ev.clientX, ev.clientY]);
        return;
      }

      setDraggingItem(draggingItem);
    },
    [activeIds, dragStart, mode],
  );

  /**
   * 判断是否是禁止状态
   */
  const isNotAllowed = useCallback(
    (targetNode: HierarchyNode) => {
      if (draggingItem === DraggingItem.NotAllowed) {
        return true;
      }

      if (draggingItem === DraggingItem.Attachable) {
        if (
          targetNode.type === ProjectNodeType.Bone ||
          targetNode.type === ProjectNodeType.Root
        ) {
          return false;
        }

        // 禁止拖动骨骼到自由部件区
        const rootParentId = getRootParentId(targetNode.id);
        if (!rootParentId) {
          return true;
        }
        const rootParent = hierarchyData[rootParentId];
        return !!(
          (rootParent.type === ProjectNodeType.Group ||
            rootParent.type === ProjectNodeType.SkinPart) &&
          !rootParent.boneId
        );
      }

      // 禁止拖拽非骨骼到root bone节点上
      if (targetNode.id === ROOT_BONE_ID) {
        return true;
      }

      // 禁止拖拽单个或多个部件/部件组到骨骼绑定的部件上
      if (targetNode.type === ProjectNodeType.SkinPart && targetNode.boneId) {
        return true;
      }

      // 禁止多个部件/部件组到骨骼上
      return (
        draggingItem === DraggingItem.MultiBasic &&
        targetNode.type === ProjectNodeType.Bone
      );
    },
    [draggingItem, hierarchyData],
  );

  /**
   * 获得自由部件区最下方的节点id
   */
  const getLastNodeId = useCallback(() => {
    let childrenIds = hierarchyData[ROOT_SKIN_ID].childrenIds;
    let lastChildId: string | undefined = undefined;
    let levelOffset = 0;

    while (childrenIds) {
      lastChildId = childrenIds[childrenIds.length - 1];
      if (!lastChildId) {
        break;
      }

      const node = hierarchyData[lastChildId];
      if (
        node.type === ProjectNodeType.SkinPart ||
        !expandedIds.includes(lastChildId)
      ) {
        break;
      }

      childrenIds = hierarchyData[lastChildId].childrenIds;
      levelOffset--;
    }

    return {
      lastChildId,
      levelOffset,
    };
  }, [expandedIds, hierarchyData]);

  const onDragOver = useCallback(
    (target?: DropTarget) => {
      if (draggingItem === DraggingItem.None) {
        return;
      }

      if (!target) {
        if (
          draggingItem === DraggingItem.Attachable ||
          draggingItem === DraggingItem.NotAllowed
        ) {
          setPointer(Pointer.NotAllowed);
          return;
        }
        setPointer(Pointer.DragSkin);

        // 拖拽部件到自由部件区的空区域，部件插入为root skin的最后一个子节点，相应位置显示提示线
        const { lastChildId, levelOffset } = getLastNodeId();
        if (!lastChildId) {
          return;
        }

        const newTarget: DropTarget = {
          hoverId: lastChildId,
          dropId: lastChildId,
          parentId: ROOT_SKIN_ID,
          levelOffset: levelOffset,
          type: 'bottom',
        };
        return newTarget;
      }

      const targetNode = hierarchyData[target.dropId];
      const notAllowed = isNotAllowed(targetNode);
      if (notAllowed) {
        setPointer(Pointer.NotAllowed);
        return;
      }

      const newTarget = Object.assign({}, target);

      if (draggingItem === DraggingItem.Attachable) {
        // 拖拽到根骨骼上，只能进行插入
        if (targetNode.id === ROOT_BONE_ID) {
          newTarget.parentId = ROOT_BONE_ID;
          newTarget.type = 'box';
        }

        setPointer(Pointer.DragBone);
        return newTarget;
      }

      // 拖动单个部件/部件组到骨骼上
      if (
        draggingItem === DraggingItem.SingleBasic &&
        targetNode.type === ProjectNodeType.Bone
      ) {
        newTarget.parentId = undefined;
        newTarget.type = 'box';

        const pointer = targetNode.skinId
          ? Pointer.ReplaceSkin
          : Pointer.BindSkin;
        setPointer(pointer);
        return newTarget;
      }

      // 拖动单个或多个部件/部件组到骨骼绑定的部件组上
      if (targetNode.type === ProjectNodeType.Group && targetNode.boneId) {
        newTarget.parentId = targetNode.id;
        newTarget.type = 'box';

        setPointer(Pointer.DragSkin);
        return newTarget;
      }

      setPointer(Pointer.DragSkin);
      return newTarget;
    },
    [draggingItem, getLastNodeId, hierarchyData, isNotAllowed],
  );

  const onDragEnd = useCallback(
    (targetId?: string, dropType?: DropType) => {
      dragEnd();
      onAbort();
      setTooltipVisible(false);

      if (
        !editor ||
        draggingItem === DraggingItem.NotAllowed ||
        draggingItem === DraggingItem.None ||
        pointer === Pointer.NotAllowed
      ) {
        return;
      }

      if (!targetId || !dropType) {
        if (
          draggingItem === DraggingItem.SingleBasic ||
          draggingItem === DraggingItem.MultiBasic
        ) {
          editor.animatorApp.nodeManager.moveActiveSkinNodes(
            ROOT_SKIN_ID,
            'box',
          );
        }
        return;
      }

      if (draggingItem === DraggingItem.Attachable) {
        editor.animatorApp.nodeManager.moveActiveBones(targetId, dropType);
        return;
      }
      editor.animatorApp.nodeManager.moveActiveSkinNodes(targetId, dropType);
    },
    [dragEnd, draggingItem, editor, onAbort, pointer],
  );

  const onRename = useCallback(
    (id: string, newName: string) => {
      if (!editor) {
        return;
      }
      editor.animatorApp.renameNode(id, newName);
      if (editingNodeId === id) {
        editor.animatorApp.nodeManager.setEditingNodeId(undefined);
      }
    },
    [editor, editingNodeId],
  );

  useEffect(() => {
    if (!treeRef.current) {
      return;
    }
    const id = activeIds.length === 1 ? activeIds[0] : getTopSelectedId();
    if (!id) {
      return;
    }
    treeRef.current.scrollTo(id, { block: 'nearest' });
  }, [activeIds]);

  const tree = useMemo(() => {
    return (
      <Tree
        ref={treeRef}
        treeData={treeData}
        expandIcon={'#icon-list-dropup'}
        expandedIds={expandedIds}
        onExpand={(ids) => {
          dispatch(setExpandedIds(ids));
        }}
        selectedIds={activeIds}
        onSelect={onSelect}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        abortRef={abortRef}
        editingNodeId={editingNodeId}
        nameMaxLength={MAX_STRING_LENGTH}
        onRename={onRename}
        attachableStyle={'treeLine'}
        isMobile={isMobile()}
      />
    );
  }, [
    treeData,
    expandedIds,
    activeIds,
    onDragStart,
    onDragOver,
    onDragEnd,
    editingNodeId,
    onRename,
    dispatch,
    onSelect,
  ]);

  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [cursorPosition, setCursorPosition] = useState<[number, number]>([
    0, 0,
  ]);

  const tooltipOptions: TooltipTriggerOptions = {
    text: intl.formatMessage({
      description: `motion mode drag tooltip text`,
      defaultMessage: `drag and drop for this item is only available in setup mode`,
    }),
    className: styles.tooltip,
    popupVisible: tooltipVisible,
    moveWithCursor: cursorPosition,
    placement: 'bottomLeft',
  };

  const onMouseEnter = useCallback(
    (ev: React.MouseEvent) => {
      if (
        mode === AnimatorMode.Motion &&
        draggingItem === DraggingItem.NotAllowed
      ) {
        setTooltipVisible(true);
        setCursorPosition([ev.clientX, ev.clientY]);
      }
    },
    [draggingItem, mode],
  );
  const onMouseLeave = useCallback(() => {
    setTooltipVisible(false);
  }, []);

  const triggerContextMenu = useCallback(
    (position: [number, number]) => {
      dispatch(
        setContextmenu({
          visible: true,
          position,
        }),
      );
    },
    [dispatch],
  );
  const touchStartTimestamp = useRef<number>(0);
  const touchStartPos = useRef<vec2 | null>(null);
  const touchMovePos = useRef<vec2 | null>(null);
  const onTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    touchStartTimestamp.current = new Date().getTime();
    if (touchStartPos.current === null) {
      touchStartPos.current = vec2.create();
    }
    vec2.set(
      touchStartPos.current,
      e.changedTouches[0].clientX,
      e.changedTouches[0].clientY,
    );
  }, []);
  const onTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    // 可能是滚动、拖拽排序，需要中断唤起菜单的操作
    if (touchStartPos.current === null) {
      return;
    }
    if (touchMovePos.current === null) {
      touchMovePos.current = vec2.create();
    }
    vec2.set(
      touchMovePos.current,
      e.changedTouches[0].clientX,
      e.changedTouches[0].clientY,
    );
    // 移动距离大于 CLICK_OFFSET_THRESHOLD 才中断操作
    if (
      vec2.distance(touchStartPos.current, touchMovePos.current) >
      CLICK_OFFSET_THRESHOLD
    ) {
      touchStartTimestamp.current = 0;
    }
  }, []);
  const onTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (!touchStartTimestamp.current) {
        return;
      }
      // 唤起菜单
      const currTimestamp = new Date().getTime();
      const touch = e.changedTouches[0];
      if (currTimestamp - touchStartTimestamp.current > LONG_PRESS_DURATION) {
        triggerContextMenu([touch.clientX, touch.clientY]);
      }
      touchStartTimestamp.current = 0;
    },
    [triggerContextMenu],
  );

  const onContextMenu = useCallback(
    (evt) => {
      triggerContextMenu([evt.clientX, evt.clientY]);
    },
    [triggerContextMenu],
  );
  return (
    <CollapsePanel
      header={intl.formatMessage({
        description: 'Hierarchy Collapse Panel',
        defaultMessage: 'List',
      })}
      id={props.panelId}
      style={{ height: '100%' }}
    >
      <TooltipTrigger {...tooltipOptions}>
        <div
          className={className}
          style={{ height: props.height }}
          // 安卓支持onContextMenu但IOS不支持，故移动端下需要屏蔽掉onContextMenu，统一用touch事件触发
          onContextMenu={isMobile() ? undefined : onContextMenu}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          {tree}
        </div>
      </TooltipTrigger>
    </CollapsePanel>
  );
}
