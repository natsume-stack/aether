import type { IntlShape } from 'react-intl';
import type { PermissionState } from '../../redux/permission-slice';

export enum FileMenuIds {
  New = 'new',
  Open = 'open',
  History = 'history',
  Import = 'import',
  Export = 'export',
  Language = 'language',
  Info = 'info',
}

type FileMenuData = {
  id: FileMenuIds;
  text: string;
  icon: string;
};

type MenuDataOptions = {
  intl: IntlShape;
  permissions: PermissionState;
};

export function getMenuData({
  intl,
  permissions,
}: MenuDataOptions): FileMenuData[] {
  const editParts = permissions.editParts;

  const data = [
    // TODO: 暂时屏蔽以下功能: Open/Info
    // {
    //   id: fileMenuIds.Open,
    //   text: intl.formatMessage({
    //     description: 'File Menu Open',
    //     defaultMessage: 'Open',
    //   }),
    //   icon: '#icon-general-folder',
    // },
    {
      id: FileMenuIds.History,
      text: intl.formatMessage({
        description: 'File Menu History',
        defaultMessage: 'History',
      }),
      icon: '#icon-general-history',
    },
    editParts && {
      id: FileMenuIds.Import,
      text: intl.formatMessage({
        description: 'File Menu Import',
        defaultMessage: 'Import',
      }),
      icon: '#icon-general-file-import',
    },
    {
      id: FileMenuIds.Export,
      text: intl.formatMessage({
        description: 'File Menu Export',
        defaultMessage: 'Export',
      }),
      icon: '#icon-general-file-export',
    },
    {
      id: FileMenuIds.Language,
      text: intl.formatMessage({
        description: 'File Menu Language',
        defaultMessage: 'Language',
      }),
      icon: '#icon-general-language',
    },
    // {
    //   id: fileMenuIds.Info,
    //   text: intl.formatMessage({
    //     description: 'File Menu Info',
    //     defaultMessage: 'Info',
    //   }),
    //   icon: '#icon-secondary-info',
    // },
  ];

  return data.filter((v): v is FileMenuData => !!v);
}
