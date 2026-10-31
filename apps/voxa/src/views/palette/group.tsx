import React, {
  memo,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { useDispatch } from 'react-redux';
import { useIntl } from 'react-intl';
import { Icon, Button, Menu, Trigger, Modal } from '@box/box-design';
import { VoxelEditorContext } from '../../internals';
import {
  PaletteRGB,
  ValidPaletteItem,
  setSelectedId,
  PaletteHSV,
  PaletteMaterial,
} from '../../redux/palette-slice';
import { useAppSelector } from '../../redux/store';
import { isPaletteItemValid } from '../../models/palette/util';
import styles from './group.module.scss';
import IconMore from './icon-more.svg';

export interface ColorItemOptions {
  id: number;
  rgb: PaletteRGB;
  hsv: PaletteHSV;
  material: PaletteMaterial;
  selected?: boolean;
}

/**
 * hsv中，明度大于该阈值时，选中框颜色为深色，否则为浅色。
 */
const DARK_THRESHOLD = 50;

export const ColorItem = memo(function ColorItemView(
  options: ColorItemOptions,
) {
  const { rgb, hsv, selected = false, id, material } = options;
  const [r, g, b] = rgb;

  const [, , v] = hsv;
  const mode = v > DARK_THRESHOLD ? 'dark' : 'light';

  const dispatch = useDispatch();

  const backgroundColor = `rgb(${r}, ${g}, ${b})`;

  const selectionBox = useMemo(() => {
    if (!selected) {
      return;
    }

    return <SelectionBox mode={mode} />;
  }, [selected, mode]);

  const emissiveIcon = useMemo(() => {
    if (!material.emissive) {
      return;
    }

    return <EmissiveIcon mode={mode} />;
  }, [material.emissive, mode]);

  function onClick() {
    if (selected) {
      return;
    }

    dispatch(setSelectedId(id));
  }

  return (
    <div className={styles.item} style={{ backgroundColor }} onClick={onClick}
      role="button" tabIndex={0} aria-label={`色板 ${id} · RGB ${r}, ${g}, ${b}`}
      aria-pressed={selected} onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}>
      {selectionBox}
      {emissiveIcon}
    </div>
  );
});

type SelectionBoxOptions = {
  /**
   * 选中框的颜色
   * light 浅色。
   * dark  深色。
   * @default light
   */
  mode?: 'light' | 'dark';
};

/**
 * 选中框。四个角有边框。
 */
function SelectionBox(options: SelectionBoxOptions) {
  const { mode = 'light' } = options;
  const modeClass = mode === 'light' ? styles.light : styles.dark;

  return (
    <div className={`${styles.selectionBox} ${modeClass}`}>
      <div className={styles.topLeft} />
      <div className={styles.topRight} />
      <div className={styles.bottomLeft} />
      <div className={styles.bottomRight} />
    </div>
  );
}

function EmissiveIcon(options: SelectionBoxOptions) {
  const { mode = 'light' } = options;
  const modeClass = mode === 'light' ? styles.light : styles.dark;

  return (
    <Icon
      className={`${styles.emissiveIcon} ${modeClass}`}
      symbolId="#icon-light"
    />
  );
}

type BtnAddOptions = {
  groupId: string;
};

function BtnAddColor(options: BtnAddOptions) {
  const { groupId } = options;

  const editor = useContext(VoxelEditorContext);
  const selectedIdx = useAppSelector((state) => state.palette.selectedId);
  const items = useAppSelector((state) => state.palette.items);

  function onClick() {
    if (!editor) {
      return;
    }

    const item = items[selectedIdx];

    if (!isPaletteItemValid(item)) {
      return;
    }

    const copiedItem: ValidPaletteItem = {
      rgb: [...item.rgb],
      material: { ...item.material },
      hsv: [...item.hsv],
    };

    editor.palette.addGroupItems({
      id: groupId,
      items: [copiedItem],
    });
  }

  return (
    <div className={`${styles.btnAdd}`} onClick={onClick}>
      <div className={styles.borderBox} />
    </div>
  );
}

export interface DefaultColorGroupOpts {
  id: string;
  children?: ReactNode;
}

function GroupBody(options: DefaultColorGroupOpts) {
  const { children, id } = options;

  return (
    <div className={styles.items}>
      {children}
      <BtnAddColor groupId={id} />
    </div>
  );
}

export const DefaultColorGroup = memo(function DefaultGroupView(
  options: DefaultColorGroupOpts,
) {
  const { children, id } = options;

  return (
    <div className={styles.group}>
      <GroupBody id={id}>{children}</GroupBody>
    </div>
  );
});

export interface CustomColorGroupOpts extends DefaultColorGroupOpts {
  name: string;
}

export const CustomColorGroup = memo(function CustomGroupView(
  options: CustomColorGroupOpts,
) {
  const { children, id, name } = options;

  const [isHovered, setIsHovered] = useState(false);
  const [isMenuVisible, setMenuVisible] = useState(false);

  const intl = useIntl();

  const group = useAppSelector(({ palette }) => palette.groups[id]);

  const editor = useContext(VoxelEditorContext);

  const showRemoveConfirmModal = useCallback(() => {
    const destroy = Modal.show({
      title: intl.formatMessage({
        description: 'Title of deleting palette group with items',
        defaultMessage: 'Delete color group',
      }),
      content: intl.formatMessage({
        description: 'Content of deleting palette group with items',
        defaultMessage: 'Used colors will be moved to the default color card',
      }),
      confirmText: intl.formatMessage({
        description: 'Confirm deleting palette group',
        defaultMessage: 'Delete',
      }),
      cancelText: intl.formatMessage({
        description: 'Cancel deleting palette group',
        defaultMessage: 'Cancel',
      }),
      type: 'warning',
      onConfirm() {
        editor?.palette.removeGroup(id);
        destroy();
      },
      onCancel() {
        destroy();
      },
      buttonSort: 'rtl',
    });
  }, [id, intl, editor]);

  const remove = useCallback(() => {
    if (group.itemIds.length === 0) {
      editor?.palette.removeGroup(id);
    } else {
      showRemoveConfirmModal();
    }

    setMenuVisible(false);
    setIsHovered(false);
  }, [group, id, editor, showRemoveConfirmModal]);

  const isBtnMoreVisible = isHovered || isMenuVisible;
  const btnMore = useMemo(() => {
    if (!isBtnMoreVisible) {
      return;
    }

    return (
      <Trigger
        placement="bottomRight"
        action={['click']}
        delay={0}
        popup={
          <Menu
            className={styles.menu}
            onItemSelect={remove}
            items={[
              {
                id: 'deleteGroup',
                text: intl.formatMessage({
                  description: 'Delete color group of palette',
                  defaultMessage: 'Delete group',
                }),
              },
            ]}
          />
        }
        onPopupVisibleChange={(visible) => {
          setMenuVisible(visible);
        }}
      >
        <Button
          className={styles.buttonMore}
          type="icon"
          icon={<IconMore className={styles.iconMore} />}
          size="small"
          onClick={() => {
            setMenuVisible(true);
          }}
        />
      </Trigger>
    );
  }, [isBtnMoreVisible, setMenuVisible, intl, remove]);

  return (
    <div className={styles.group}>
      <div
        className={styles.header}
        onMouseEnter={() => {
          setIsHovered(true);
        }}
        onMouseLeave={() => {
          setIsHovered(false);
        }}
      >
        <Icon className={styles.icon} symbolId="#icon-general-folder" />
        <p>{name}</p>
        {btnMore}
      </div>
      <GroupBody id={id}>{children}</GroupBody>
    </div>
  );
});
