import React, { ReactNode, useContext, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { Toast, ModalView } from '@box/box-design';
import { useAppSelector } from '../../redux/store';
import { VoxelEditorContext } from '../../internals';
import { getContentUrl } from '../../utils/url';
import { DateTime } from './utils';
import { FileMenuContext } from './context';
import styles from './style.module.scss';

export type CardProps = {
  id: string;
  modelName?: string;
  modelPreviewHash?: string;
  projectFileHash?: string;
  dateTime?: DateTime;
};

function Card(params: { img: ReactNode; desc: ReactNode }) {
  const { img, desc } = params;
  return (
    <div className={styles.card}>
      <div className={styles.cardImgBorder}>{img}</div>
      <div className={styles.cardDesc}>{desc}</div>
    </div>
  );
}

export function CardNew() {
  const intl = useIntl();

  const img = (
    <div
      className={styles.cardImg}
      onClick={() => {
        window.open(window.location.origin, '_blank')?.focus();
      }}
    >
      <div className={styles.blank}></div>
    </div>
  );

  const desc = useMemo(() => {
    return (
      <span>
        {intl.formatMessage({
          description: 'Create New Project',
          defaultMessage: 'Blank',
        })}
      </span>
    );
  }, [intl]);

  return <Card img={img} desc={desc} />;
}

export function CardLoad(params: CardProps) {
  const editor = useContext(VoxelEditorContext);
  const { onClose } = useContext(FileMenuContext);
  const intl = useIntl();

  const projectName = useAppSelector((state) => state.app.projectName);
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);

  const {
    projectFileHash = '',
    modelPreviewHash,
    modelName,
    dateTime,
  } = params;

  // 确认加载历史文件的模态框
  const restoreModal = useMemo(() => {
    if (!showModal) {
      return;
    }

    const onConfirm = async () => {
      if (!editor) {
        return;
      }
      setLoading(true);
      try {
        await editor.projectManager.loadProjectFile({
          projectFileHash: projectFileHash,
          projectName,
        });
        Toast.success({
          content: intl.formatMessage({
            description: 'Restore successfully',
            defaultMessage: 'Restored',
          }),
        });
        setLoading(false);
        setShowModal(false);
        onClose();
      } catch (error) {
        Toast.error({
          content: intl.formatMessage({
            description: 'Restore error',
            defaultMessage: 'Fail to restore. Please try again later.',
          }),
        });
        setLoading(false);
        return;
      }
    };

    const onCancel = () => {
      setLoading(false);
      setShowModal(false);
    };

    return (
      <ModalView
        title={intl.formatMessage({
          description: 'Title of confirm restoring history version',
          defaultMessage: 'Restore',
        })}
        content={intl.formatMessage({
          description: 'Content of confirm restoring history version',
          defaultMessage: 'Overwrite current project with history version',
        })}
        confirmText={intl.formatMessage({
          description: 'Confirm restoring history version',
          defaultMessage: 'Restore',
        })}
        onConfirm={onConfirm}
        cancelText={intl.formatMessage({
          description: 'Cancel restoring history version',
          defaultMessage: 'Cancel',
        })}
        onCancel={onCancel}
        buttonSort={'rtl'}
        confirmLoading={loading}
      />
    );
  }, [editor, intl, loading, onClose, projectFileHash, projectName, showModal]);

  let desc: ReactNode;

  const img = modelPreviewHash ? (
    <img
      className={styles.cardImg}
      onClick={() => setShowModal(true)}
      src={getContentUrl(modelPreviewHash)}
      alt="preview"
      width={160}
      height={160}
    />
  ) : undefined;

  if (modelName) {
    desc = <span>{modelName}</span>;
  } else if (dateTime) {
    desc = (
      <div className={styles.time}>
        <span>{dateTime.date}</span>
        <span>{dateTime.time}</span>
      </div>
    );
  }

  return (
    <>
      <Card img={img} desc={desc} />
      {restoreModal}
    </>
  );
}
