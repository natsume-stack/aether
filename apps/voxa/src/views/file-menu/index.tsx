import React, { memo, useEffect, useRef } from 'react';
import { Button } from '@box/box-design';
import { FileMenuContext } from './context';
import { HierarchyMenu } from './hierarchy-menu';
import styles from './style.module.scss';

type FileMenuProps = {
  onClose: () => void;
};

function FileMenuView(props: FileMenuProps) {
  const { onClose } = props;
  const fileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fileMenuRef.current && fileMenuRef.current.focus();
  }, []);

  return (
    <FileMenuContext.Provider value={{ onClose }}>
      <div
        ref={fileMenuRef}
        className={styles.fileMenu}
        tabIndex={-1}
        // 防止触发onBlur
        onMouseDown={(ev) => ev.preventDefault()}
        onBlur={onClose}
      >
        <div className={styles.menuTitle}>
          <Button
            className={styles.iconBtn}
            type="icon"
            icon="#icon-secondary-delete"
            onClick={(ev) => {
              ev.stopPropagation();
              onClose();
            }}
          />
        </div>
        <div className={styles.menuContent}>
          <HierarchyMenu />
        </div>
      </div>
    </FileMenuContext.Provider>
  );
}

export const FileMenu = memo(FileMenuView);
