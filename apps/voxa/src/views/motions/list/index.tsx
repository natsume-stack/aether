import { useCallback, useContext, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import {
  Button,
  Toast,
  Modal,
  TooltipTrigger,
  DropType,
  Tree,
  TreeNode,
  TreeNodeType,
  SerializedVec2,
  useSharedTipsDelay,
  TriggerOptions,
} from '@box/box-design';
import { useAppSelector } from '../../../redux/store';
import { MotionHeader } from '../header';
import { VoxelEditorContext } from '../../../internals';
import { moveMotion, renameMotion } from '../../../redux/animator-slice';
import { MAX_MOTION_LENGTH } from '../../../models/animator-app/util';
import { ContextMenu, ContextmenuData } from '../../contextmenu';
import { isValidName, MAX_NAME_LENGTH } from '../../../defs';
import styles from './style.module.scss';

export function MotionList() {
  const { activeMotionId, motionData } = useAppSelector(({ animator }) => ({
    activeMotionId: animator.activeMotionId,
    motionData: animator.motionData,
  }));

  const treeData = useMemo<TreeNode[]>(
    () =>
      motionData.motionIds.map((motionId) => {
        const motion = motionData.motions[motionId];

        const className =
          activeMotionId !== motionId
            ? styles.treeNode
            : [styles.treeNode, styles.selected].join(' ');

        return {
          id: motionId,
          name: motion.name,
          type: TreeNodeType.Basic,
          disableExpand: true,
          className,
          icon:
            activeMotionId === motionId
              ? '#icon-secondary-first-animations'
              : undefined,
        };
      }),
    [motionData, activeMotionId],
  );

  const editor = useContext(VoxelEditorContext);

  const { motionIds, motions } = motionData;

  const reachingMaxLength = motionIds.length >= MAX_MOTION_LENGTH;

  const createMotion = useCallback(() => {
    if (!editor || reachingMaxLength) {
      return;
    }

    editor.motionPlayer.pause();

    const newMotion = editor.animatorApp.motionManager.addMotion();

    if (newMotion) {
      setEditingMotionId(newMotion.id);
    }
  }, [editor, reachingMaxLength]);

  const selectMotion = useCallback(
    ([motionId]: string[]) => {
      if (!editor || activeMotionId == motionId) {
        return;
      }

      editor.motionPlayer.pause();

      editor.animatorApp.motionManager.selectMotion(motionId);
    },
    [editor, activeMotionId],
  );

  const onDragEnd = useCallback(
    (targetId?: string, dropType?: DropType) => {
      if (!targetId || !dropType) {
        return;
      }
      editor?.history.saveAction({
        action: moveMotion({
          id: activeMotionId,
          dropTargetId: targetId,
          dropType,
        }),
      });
    },
    [editor, activeMotionId],
  );

  const [editingMotionId, setEditingMotionId] = useState<string | undefined>();

  const [contextMenuPos, setContextMenuPos] = useState<
    SerializedVec2 | undefined
  >();

  const intl = useIntl();

  const onRemoveMotion = useCallback(() => {
    const destroy = Modal.show({
      type: 'warning',
      buttonSort: 'rtl',
      title: intl.formatMessage({
        description: 'Title of removing motion',
        defaultMessage: 'Delete the motion',
      }),
      content: intl.formatMessage({
        description: 'Content of removing motion',
        defaultMessage: 'Confirm to delete the motion',
      }),
      confirmText: intl.formatMessage({
        description: 'Confirm text of removing motion',
        defaultMessage: 'Delete',
      }),
      cancelText: intl.formatMessage({
        description: 'Cancel text of removing motion',
        defaultMessage: 'Cancel',
      }),
      onConfirm: () => {
        editor?.animatorApp.motionManager.removeMotion(activeMotionId);
        destroy();
      },
      onCancel: () => destroy(),
    });
  }, [intl, editor, activeMotionId]);

  const contextMenu = useMemo(() => {
    if (!contextMenuPos) {
      return;
    }

    const list: (ContextmenuData | false)[] = [
      !reachingMaxLength && {
        id: ContextMenuId.Copy,
        text: intl.formatMessage({
          description: 'Motion list context menu make a copy',
          defaultMessage: 'Make a copy',
        }),
      },
      {
        id: ContextMenuId.Rename,
        text: intl.formatMessage({
          description: 'Motion list context menu rename',
          defaultMessage: 'Rename',
        }),
      },
      {
        id: ContextMenuId.Delete,
        text: intl.formatMessage({
          description: 'Motion list context menu delete',
          defaultMessage: 'Delete',
        }),
      },
    ];

    const data: ContextmenuData[] = list.filter(
      (item): item is ContextmenuData => !!item,
    );

    const onCopy = () => {
      if (!editor) {
        return;
      }

      const newId = editor.animatorApp.motionManager.copyMotion(activeMotionId);

      newId && setEditingMotionId(newId);
    };

    const onSelect = (id: string) => {
      if (!editor) {
        return;
      }

      switch (id) {
        case ContextMenuId.Copy:
          onCopy();
          break;
        case ContextMenuId.Rename:
          setEditingMotionId(activeMotionId);
          break;
        case ContextMenuId.Delete:
          onRemoveMotion();
          break;
      }
    };

    const onBlur = () => {
      setContextMenuPos(undefined);
    };

    return (
      <ContextMenu
        position={contextMenuPos}
        data={data}
        onSelect={onSelect}
        onBlur={onBlur}
      />
    );
  }, [
    contextMenuPos,
    intl,
    editor,
    activeMotionId,
    reachingMaxLength,
    setEditingMotionId,
    onRemoveMotion,
  ]);

  const onContextMenu = useCallback(
    (evt: React.MouseEvent) => {
      setContextMenuPos([evt.clientX, evt.clientY]);
    },
    [setContextMenuPos],
  );

  const onRename = useCallback(
    (id: string, untrimmed: string) => {
      const newName = untrimmed.trim();

      const isDuplicated = Object.values(motions).find((motion) => {
        return motion && motion.id !== id && motion.name === newName;
      });

      if (!isDuplicated) {
        editor?.history.saveAction({
          action: renameMotion({ motionId: id, newName }),
        });
      } else {
        Toast.default({
          content: intl.formatMessage({
            description:
              'Toast content when renaming motion with duplicated name',
            defaultMessage: 'The motion name is already in use',
          }),
          description: intl.formatMessage({
            description:
              'Toast description when renaming motion with duplicated name',
            defaultMessage: 'Please select another name',
          }),
        });
      }

      setEditingMotionId(undefined);
    },
    [editor, motions, intl],
  );

  const { delay, setDisplayed } = useSharedTipsDelay();

  const onPopupVisibleChange = useCallback(
    (visible: boolean) => {
      visible && setDisplayed(visible);
    },
    [setDisplayed],
  );

  const triggerOptions = useMemo<TriggerOptions>(() => {
    return {
      onPopupVisibleChange,
      delay,
      placement: 'top',
    };
  }, [delay, onPopupVisibleChange]);

  return (
    <div className={styles.motionList}>
      <MotionHeader
        title={intl.formatMessage({
          description: 'Motions List',
          defaultMessage: 'Motions',
        })}
        button={
          <TooltipTrigger
            {...triggerOptions}
            text={intl.formatMessage({
              description: 'Motion button create motion',
              defaultMessage: 'Create motion',
            })}
          >
            <Button
              type="icon"
              icon="#icon-general-add"
              size="small"
              disabled={reachingMaxLength}
              onClick={createMotion}
            />
          </TooltipTrigger>
        }
      />
      <div className={styles.body} onContextMenu={onContextMenu}>
        <Tree
          treeData={treeData}
          className={styles.tree}
          expandIcon=""
          selectedIds={[activeMotionId]}
          editingNodeId={editingMotionId}
          onSelect={selectMotion}
          onDragEnd={onDragEnd}
          onRename={onRename}
          renameValidator={isValidName}
          nameMaxLength={MAX_NAME_LENGTH}
        />
        {contextMenu}
      </div>
    </div>
  );
}

enum ContextMenuId {
  Copy = 'COPY',
  Rename = 'RENAME',
  Delete = 'DELETE',
}
