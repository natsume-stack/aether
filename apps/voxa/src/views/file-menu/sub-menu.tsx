import React, {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import {
  ToolbarMenuContext,
  useClassName,
  Menu,
  Toast,
} from '@box/box-design';
import { VoxelEditorContext } from '../../internals';
import type { VoxelEditor } from '../../models/editor';
import { CardLoad, CardNew, CardProps } from './card';
import { FileMenuIds } from './menu-data';
import { formatDateTime } from './utils';
import EmptyListSvg from './empty-list.svg';
import styles from './style.module.scss';
import { downloadFile } from '../../utils/file';
import { useAppSelector } from '../../redux/store';
import { LangType, isLangType, localeMap } from '../../utils/i18n';
import { RootContext } from '../../root-context';
import { apis } from '../../apis';
import { EditType } from '../../redux/app-slice';
import {
  createProjectBundle,
  getProjectBundleFileName,
  readProjectBundle,
} from '../../models/file-tools/project-bundle';

export const SubMenu = memo(SubMenuView);

function SubMenuView() {
  const { selectedItem } = useContext(ToolbarMenuContext);

  const menu = useMemo(() => {
    switch (selectedItem) {
      case FileMenuIds.New:
        return <SubMenuNew />;
      case FileMenuIds.History:
        return <SubMenuHistory />;
      case FileMenuIds.Import:
        return <SubMenuImport />;
      case FileMenuIds.Export:
        return <SubMenuExport />;
      case FileMenuIds.Language:
        return <SubMenuLanguage />;
      default:
        return;
    }
  }, [selectedItem]);

  return <>{menu}</>;
}

function SubMenuNew() {
  const className = useClassName([styles.subMenu, styles.cardList]);

  return (
    <div className={className}>
      <CardNew />
    </div>
  );
}

function SubMenuHistory() {
  const editor = useContext(VoxelEditorContext);
  const intl = useIntl();
  const [cardList, setCardList] = useState<CardProps[]>([]);

  // 获得模型的历史版本列表
  const getSnapshotList = useCallback(
    async (signal: AbortSignal, autoSave: boolean = false) => {
      if (!editor) {
        return;
      }

      const snapshotList = await editor.projectManager.getSnapshotList({
        autoSave,
        signal,
      });

      if (!snapshotList) {
        return;
      }

      const cardList = snapshotList.map((snapshot): CardProps => {
        const { createdAt, snapshotId, projectFileHash, modelPreviewHash } =
          snapshot;

        return {
          id: snapshotId + '',
          modelPreviewHash,
          projectFileHash,
          dateTime: formatDateTime({
            intl,
            createAt: String(createdAt),
          }),
        };
      });

      setCardList(cardList);
    },
    [editor, intl],
  );

  useEffect(() => {
    const abortController = new AbortController();
    getSnapshotList(abortController.signal);
    return () => {
      abortController.abort();
    };
  }, [getSnapshotList]);

  // 空列表图标及提示
  const emptyList = useMemo(() => {
    return (
      <div className={styles.emptyList}>
        <EmptyListSvg />
        <span>
          {intl.formatMessage({
            description: 'Empty Card List',
            defaultMessage: 'No Project',
          })}
        </span>
      </div>
    );
  }, [intl]);

  const cards =
    cardList.length === 0
      ? emptyList
      : cardList.map((props: CardProps) => {
          return <CardLoad key={props.id} {...props} />;
        });

  const className = useClassName([styles.subMenu, styles.cardList]);

  return <div className={className}>{cards}</div>;
}

enum SubMenuImportId {
  ImportVoxObj = 'IMPORT_VOX_OBJ',
  ImportProject = 'IMPORT_PROJECT',
}

let inputCache: HTMLInputElement | undefined;
let projectInputCache: HTMLInputElement | undefined;

/**
 * 把创建的input缓存起来。
 * - 避免在组件中执行方法结束后，input被销毁，导致change事件没触发。
 * - 也不能放到document.body上再在change中remove，因为change不一定会被触发（用户点取消关闭弹窗）。
 */
function createUploadInputElement(editor: VoxelEditor) {
  if (!inputCache) {
    inputCache = document.createElement('input');

    inputCache.type = 'file';
    inputCache.accept = '.vox';
    inputCache.multiple = false;

    inputCache.addEventListener('change', async () => {
      if (!inputCache || !inputCache.files || !editor) {
        return;
      }

      const [file] = inputCache.files;

      if (!file) {
        return;
      }

      const result = await editor.voxTool.loadMultipleParts(file);

      if (!result.isSuccess) {
        console.error(
          'Cannot load .vox as multiple skinNodes',
          result.body.msg,
        );
      }

      // 在这里清理掉，避免重新选择相同的文件时，不会再次触发'change'。
      inputCache = undefined;
    });
  }

  return inputCache;
}

function createProjectUploadInputElement(params: {
  editor: VoxelEditor;
  editType: EditType;
  onSuccess: () => void;
  onInvalid: () => void;
  onTypeMismatch: () => void;
}) {
  if (!projectInputCache) {
    projectInputCache = document.createElement('input');
    projectInputCache.type = 'file';
    projectInputCache.accept = '.voxaproject,.voxa-project';
    projectInputCache.multiple = false;
  }

  projectInputCache.onchange = async () => {
    const input = projectInputCache;
    const file = input?.files?.[0];
    projectInputCache = undefined;
    if (!file) return;

    try {
      const project = await readProjectBundle(file);
      if (project.editType !== params.editType) {
        params.onTypeMismatch();
        return;
      }
      params.editor.projectManager.loadImportedProject(
        project.projectData,
        project.projectName,
      );
      params.onSuccess();
    } catch (error) {
      console.error('Failed to import VOXA project', error);
      params.onInvalid();
    }
  };

  return projectInputCache;
}

function SubMenuImport() {
  const intl = useIntl();

  const className = useClassName([styles.subMenu, styles.import], []);

  const editor = useContext(VoxelEditorContext);

  const editType = useAppSelector(({ app }) => app.editType);

  return (
    <div className={className}>
      <p className={styles.subMenuText}>
        {intl.formatMessage({
          description: 'Text for importing model to object',
          defaultMessage: 'Import model to object',
        })}
      </p>
      <Menu
        className={styles.importListMenu}
        selectedItem=""
        onItemSelect={(id) => {
          if (!editor) {
            return;
          }

          switch (id) {
            case SubMenuImportId.ImportVoxObj:
              {
                const input = createUploadInputElement(editor);

                input.click();
              }
              break;
            case SubMenuImportId.ImportProject: {
              const input = createProjectUploadInputElement({
                editor,
                editType,
                onSuccess: () =>
                  Toast.success({
                    content: intl.formatMessage({
                      description: 'VOXA project import success',
                      defaultMessage: '工程导入成功',
                    }),
                  }),
                onInvalid: () =>
                  Toast.error({
                    content: intl.formatMessage({
                      description: 'VOXA project import invalid file',
                      defaultMessage: '无法读取该工程文件',
                    }),
                  }),
                onTypeMismatch: () =>
                  Toast.error({
                    content: intl.formatMessage({
                      description: 'VOXA project import type mismatch',
                      defaultMessage: '模型工程和皮肤工程不能互相导入',
                    }),
                  }),
              });
              input.click();
              break;
            }
          }
        }}
        items={[
          {
            id: SubMenuImportId.ImportVoxObj,
            text: intl.formatMessage({
              description: 'File menu import VOX as object',
              defaultMessage: 'Import VOX',
            }),
          },
          {
            id: SubMenuImportId.ImportProject,
            text: intl.formatMessage({
              description: 'File menu import VOXA project',
              defaultMessage: '导入工程',
            }),
          },
        ]}
      />
    </div>
  );
}

enum SubMenuExportId {
  ExportGLTF = 'EXPORT_GLTF',
  ExportProject = 'EXPORT_PROJECT',
}

function SubMenuExport() {
  const intl = useIntl();

  const className = useClassName([styles.subMenu, styles.import], []);

  const editor = useContext(VoxelEditorContext);

  const projectName = useAppSelector(({ app }) => app.projectName);
  const editType = useAppSelector(({ app }) => app.editType);

  const exportGLTF = useCallback(async () => {
    if (!editor) {
      return;
    }

    const { isSuccess, body } = await editor.gltfTool.generateGLTF();

    if (isSuccess) {
      downloadFile(body, `${projectName}.gltf`);
    } else {
      Toast.error({
        content: intl.formatMessage({
          description: 'Error message for exporting GLTF',
          defaultMessage: 'Failed to export',
        }),
      });
    }
  }, [editor, intl, projectName]);

  const exportProject = useCallback(async () => {
    if (!editor) {
      return;
    }
    try {
      const projectData = await editor.projectManager.getData();
      const bundle = await createProjectBundle({
        projectData,
        projectName,
        editType,
      });
      downloadFile(bundle, getProjectBundleFileName(projectName));
      Toast.success({
        content: intl.formatMessage({
          description: 'VOXA project export success',
          defaultMessage: '工程已导出',
        }),
      });
    } catch (err) {
      console.error('Failed to export VOXA project', err);
      Toast.error({
        content: intl.formatMessage({
          description: 'VOXA project export error',
          defaultMessage: '工程导出失败',
        }),
      });
    }
  }, [editor, editType, intl, projectName]);

  return (
    <div className={className}>
      <Menu
        className={styles.importListMenu}
        selectedItem=""
        onItemSelect={async (id) => {
          switch (id) {
            case SubMenuExportId.ExportGLTF:
              exportGLTF();
              break;
            case SubMenuExportId.ExportProject:
              exportProject();
              break;
          }
        }}
        items={[
          {
            id: SubMenuExportId.ExportGLTF,
            text: intl.formatMessage({
              description: 'File menu export GLTF',
              defaultMessage: 'Export GLTF',
            }),
          },
          {
            id: SubMenuExportId.ExportProject,
            text: intl.formatMessage({
              description: 'File menu export VOXA project',
              defaultMessage: '导出工程',
            }),
          },
        ]}
      />
    </div>
  );
}

function SubMenuLanguage() {
  const { setLocale } = useContext(RootContext);
  const intl = useIntl();
  const languageMenuData: { id: LangType; text: string }[] = [
    {
      id: localeMap['zh_CN'],
      text: intl.formatMessage({
        description: 'File menu set language as zh-Hans',
        defaultMessage: '简体中文',
      }),
    },
    {
      id: localeMap['en_US'],
      text: intl.formatMessage({
        description: 'File menu set Language as en',
        defaultMessage: 'English',
      }),
    },
  ];

  return (
    <div className={styles.mainMenu}>
      <Menu
        className={styles.menuItemContainer}
        items={languageMenuData}
        onItemSelect={async (id) => {
          if (isLangType(id)) {
            setLocale(id);
            try {
              await apis.createra.setUserLanguage(localeMap[id]);
            } catch (error) {
              console.error(error);
            }
          }
        }}
        selectedItem={intl.locale}
      />
    </div>
  );
}
