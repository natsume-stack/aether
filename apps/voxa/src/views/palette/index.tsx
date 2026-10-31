import { nanoid } from 'nanoid';
import React, { useCallback, useContext, useMemo } from 'react';
import { useIntl } from 'react-intl';
import {
  CollapsePanel,
  Button,
  Modal,
  TooltipTrigger,
  SharedTipsContext,
} from '@box/box-design';
import { useAppSelector } from '../../redux/store';
import { ColorItem, CustomColorGroup, DefaultColorGroup } from './group';
import { Settings } from './settings';
import { VoxelEditorContext } from '../../internals';
import { AppMode } from '../../redux/app-slice';
import { isPaletteItemValid } from '../../models/palette/util';
import { incrementalNaming, PALETTE_GROUP_NAME } from '../../utils/naming';
import styles from './style.module.scss';

type PaletteProps = {
  panelId: number;
  height: string;
};

export function Palette(props: PaletteProps) {
  const { palette, appMode } = useAppSelector((state) => ({
    palette: state.palette,
    appMode: state.app.mode,
  }));
  const { groups } = palette;

  const isAnimator = appMode === AppMode.Animator;
  const defaultGroupId = palette.groupList[0];

  const editor = useContext(VoxelEditorContext);
  const intl = useIntl();

  const groupElements = useMemo(() => {
    return palette.groupList.map((groupId) => {
      const items: JSX.Element[] = [];

      const group = palette.groups[groupId];

      group.itemIds.forEach((id) => {
        const item = palette.items[id];

        if (!isPaletteItemValid(item)) {
          return;
        }

        const { rgb, hsv, material } = item;

        items.push(
          <ColorItem
            key={id}
            id={id}
            rgb={rgb}
            hsv={hsv}
            selected={id === palette.selectedId}
            material={material}
          />,
        );
      });

      if (groupId === defaultGroupId) {
        return (
          <DefaultColorGroup key={defaultGroupId} id={defaultGroupId}>
            {items}
          </DefaultColorGroup>
        );
      } else {
        return (
          <CustomColorGroup key={groupId} id={group.id} name={group.name}>
            {items}
          </CustomColorGroup>
        );
      }
    });
  }, [palette, defaultGroupId]);

  const { setDisplayed, delay } = useContext(SharedTipsContext);

  const addCustomGroup = useCallback(() => {
    const groupValues = Object.values(groups);

    const name = incrementalNaming(
      PALETTE_GROUP_NAME,
      groupValues,
      (group, newName) => group.name !== newName,
    );

    editor?.palette.addGroup({
      name,
      id: nanoid(),
      items: [],
    });
  }, [editor, groups]);

  const extra = useMemo(() => {
    const placement = 'bottom';
    const align = { offset: [0, 4] };
    const onPopupVisibleChange = (visible: boolean) => {
      visible && setDisplayed(true);
    };

    return (
      <div className={styles.extra}>
        <TooltipTrigger
          placement={placement}
          align={align}
          onPopupVisibleChange={onPopupVisibleChange}
          delay={delay}
          text={intl.formatMessage({
            description: 'buttonMoreColor',
            defaultMessage: 'More Color',
          })}
        >
          <Button
            className={styles.iconBtn}
            size="small"
            type="icon"
            icon="#icon-secondary-color-library"
            disabled
          />
        </TooltipTrigger>
        <TooltipTrigger
          placement={placement}
          align={align}
          onPopupVisibleChange={onPopupVisibleChange}
          delay={delay}
          text={intl.formatMessage({
            description: 'buttonNewColorGroup',
            defaultMessage: 'New Color Group',
          })}
        >
          <Button
            className={styles.iconBtn}
            size="small"
            type="icon"
            icon="#icon-general-folder-add"
            onClick={addCustomGroup}
          />
        </TooltipTrigger>
        <TooltipTrigger
          placement={placement}
          align={align}
          onPopupVisibleChange={onPopupVisibleChange}
          delay={delay}
          text={intl.formatMessage({
            description: 'buttonClearUnusedColor',
            defaultMessage: 'Clear unused colors',
          })}
        >
          <Button
            className={styles.iconBtn}
            size="small"
            type="icon"
            icon="#icon-secondary-clear"
            onClick={() => {
              const destroy = Modal.show({
                type: 'warning',
                title: intl.formatMessage({
                  description: 'clearUnusedColorsTitle',
                  defaultMessage: 'Clear unused colors',
                }),
                content: intl.formatMessage({
                  description: 'clearUnusedColorsContent',
                  defaultMessage:
                    'Confirm to clear all unused colors in the swatch?',
                }),
                confirmText: intl.formatMessage({
                  description: 'clearUnusedColorsConfirm',
                  defaultMessage: 'Clear',
                }),
                onConfirm: () => {
                  if (!editor) {
                    return;
                  }

                  editor.palette.removeUnusedItems();
                  destroy();
                },
                cancelText: intl.formatMessage({
                  description: 'clearUnusedColorsCancel',
                  defaultMessage: 'Keep',
                }),
                onCancel: () => {
                  destroy();
                },
                buttonSort: 'rtl',
              });
            }}
          />
        </TooltipTrigger>
      </div>
    );
  }, [editor, intl, setDisplayed, delay, addCustomGroup]);

  return (
    <CollapsePanel
      header={intl.formatMessage({
        description: 'Palette Collapse Panel',
        defaultMessage: 'Color',
      })}
      id={props.panelId}
      showArrow={isAnimator}
      showDivider={isAnimator}
      extra={extra}
      style={{ height: '100% ' }}
    >
      <div
        className={styles.palette}
        style={{ paddingTop: isAnimator ? '8px' : '0', height: props.height }}
      >
        <div className={styles.groups}>{groupElements}</div>
        <Settings />
      </div>
    </CollapsePanel>
  );
}
