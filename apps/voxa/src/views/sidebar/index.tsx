import React, { useMemo, ReactNode, useRef, useContext } from 'react';
import { useIntl } from 'react-intl';
import {
  Toolbar,
  ToolbarGap,
  ToolbarOptions,
  ToolItem,
  ToolItemOptions,
  Menu,
} from '@box/box-design';
import {
  animatorStateToSection,
  editingStateToSelection,
  GAP,
  getMenuData,
  OnTrigger,
} from './menu-data';
import { VoxelEditorContext } from '../../internals';
import { useAppSelector } from '../../redux/store';
import { AppMode } from '../../redux/app-slice';
import { AnimatorMode } from '../../redux/animator-slice';
import styles from './style.module.scss';

type SidebarProps = {
  type: AppMode;
};

/**
 * 编辑器的侧边栏。根据当前的工具不同（部件编辑、体素编辑），展示不同菜单。
 */
export function Sidebar(props: SidebarProps) {
  const editor = useContext(VoxelEditorContext);
  const intl = useIntl();

  const triggerEffect = useRef<ReturnType<OnTrigger>>();

  const selection: string | undefined = useAppSelector((state) => {
    if (state.app.mode === AppMode.Animator) {
      return animatorStateToSection(state.animator);
    }
    const { mode, toolType } = state.editing;

    return editingStateToSelection({ mode, toolType });
  });

  const { pivotMode, mode, addType, hitBoxMode } = useAppSelector(
    (state) => state.animator,
  );

  const editType = useAppSelector((state) => state.app.editType);

  const { items, onSelect } = useMemo(() => {
    let items: ReactNode;
    let onSelect: ToolbarOptions['onSelect'] = () => {};
    if (!editor) {
      return { items, onSelect };
    }

    const menuData = getMenuData({
      type: props.type,
      pivotMode,
      hitBoxMode,
      addType,
      animatorMode: mode,
      editor,
      intl,
      editType,
    });

    const gapHeight = props.type === AppMode.Voxel ? 16 : 24;

    onSelect = ({ id }) => {
      let onTrigger: OnTrigger | undefined;

      menuData.find((data) => {
        if (data === GAP) {
          return;
        }

        if (data.menu) {
          return data.menu.find((sub) => {
            if (sub.id === id) {
              onTrigger = sub.onTrigger;

              return true;
            }
          });
        }

        if (data.id === id) {
          onTrigger = data.onTrigger;

          return true;
        }
      });

      if (!onTrigger) {
        return;
      }

      triggerEffect.current && triggerEffect.current();

      triggerEffect.current = onTrigger();
    };

    items = menuData.map((data, idx) => {
      if (data === GAP) {
        return <ToolbarGap key={`gap-${idx}`} height={gapHeight} />;
      }

      const { id, icon, menu, tooltip, disabled, onItemClick, selectedItem } =
        data;

      if (!menu) {
        return (
          <ToolItem
            key={id}
            id={id}
            icon={icon}
            tooltip={tooltip}
            disabled={disabled}
            onItemClick={onItemClick}
          />
        );
      }

      const subSelections: ToolItemOptions['subSelections'] = [];

      const items = menu.map((menuData) => {
        const { id, icon, text } = menuData;

        subSelections.push({ id, icon });

        return {
          id,
          icon,
          text,
        };
      });

      const itemMenu = (
        <Menu
          items={items}
          onItemSelect={(id) => onSelect({ id })}
          selectedItem={selectedItem || selection}
        />
      );

      return (
        <ToolItem
          key={id}
          id={id}
          icon={icon}
          subSelections={subSelections}
          tooltip={tooltip}
          disabled={disabled}
          onItemClick={onItemClick}
          selectedItem={selectedItem}
        >
          {itemMenu}
        </ToolItem>
      );
    });

    return { items, onSelect, menuData };
  }, [
    editor,
    props.type,
    pivotMode,
    hitBoxMode,
    addType,
    mode,
    intl,
    editType,
    selection,
  ]);

  return (
    <div className={styles.sideBar}>
      <Toolbar
        className={styles.toolbar}
        defaultSelection={'attach-block'}
        onSelect={onSelect}
        selection={selection}
      >
        {items}
      </Toolbar>
    </div>
  );
}
