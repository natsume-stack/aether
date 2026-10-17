import React, { memo, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { useAppSelector } from '../../redux/store';
import {
  Menu,
  ToolbarMenuContext,
  ToolbarMenuContextProps,
} from '@box/box-design';
import { getMenuData } from './menu-data';
import styles from './style.module.scss';
import { SubMenu } from './sub-menu';

function HierarchyMenuView() {
  const intl = useIntl();

  const permissions = useAppSelector((state) => state.permission);

  const menuData = useMemo(
    () => getMenuData({ intl, permissions }),
    [intl, permissions],
  );

  const [selectedItem, setSelectedItem] = useState<
    ToolbarMenuContextProps['selectedItem']
  >(menuData[0].id);

  // 获取一级菜单
  const itemMenu = useMemo(
    () => (
      <div className={styles.mainMenu}>
        <Menu
          className={styles.menuItemContainer}
          items={menuData}
          onItemSelect={setSelectedItem}
          selectedItem={selectedItem}
        />
      </div>
    ),
    [menuData, setSelectedItem, selectedItem],
  );

  const onItemSelect: ToolbarMenuContextProps['onItemSelect'] = (options) => {
    const { id: key } = options;

    setSelectedItem(key);
  };

  return (
    <ToolbarMenuContext.Provider value={{ selectedItem, onItemSelect }}>
      {itemMenu}
      <div className={styles.divider} />
      {<SubMenu />}
    </ToolbarMenuContext.Provider>
  );
}

export const HierarchyMenu = memo(HierarchyMenuView);
