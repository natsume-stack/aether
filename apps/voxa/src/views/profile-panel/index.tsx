import { memo, ReactNode, Ref, useCallback, useContext, useMemo } from 'react';
import { useIntl } from 'react-intl';
import { useAppSelector } from '../../redux/store';
import styles from './style.module.scss';
import { AppMode, NodeAlphaCache } from '../../redux/app-slice';
import { HierarchyData, ProjectNodeType } from '../../redux/animator-slice';
import { getActiveBoneIds } from '../../models/animator-app/util';
import { VoxelEditorContext } from '../../internals';
import type { VoxelEditor } from '../../models/editor';

type DataSetValue = {
  key: string;
  name: string;
  value: string;
};

type DataSet = DataSetValue[];

function ProfilePanelView() {
  const {
    mode,
    nodeAlphaCache,
    hierarchyData,
    activeIds,
    relativeIds,
    activeSkinPartIds,
    relativeSkinPartIds,
  } = useAppSelector(({ app, animator }) => {
    return {
      mode: app.mode,
      nodeAlphaCache: app.nodeAlphaCache,
      hierarchyData: animator.hierarchyData,
      activeIds: animator.activeIds,
      relativeIds: animator.relativeIds,
      activeSkinPartIds: animator.activeSkinPartIds,
      relativeSkinPartIds: animator.relativeSkinPartIds,
    };
  });

  const intl = useIntl();

  const editor = useContext(VoxelEditorContext);

  /**
   * 传入分子、分母，返回 分子/分母，并且数值按照千分位加分隔符
   * 比如：getGroupingUnit(1001, 2000)，得到 1,001/2,000
   * 用的是formatJS的grouping转换
   * 详见：https://unicode-org.github.io/icu/userguide/format_parse/numbers/skeletons.html#grouping
   */
  const getGroupingFraction = useCallback(
    (numerator: number, denominator: number) => {
      const options = { useGrouping: true };

      return `${intl.formatNumber(numerator, options)} / ${intl.formatNumber(
        denominator,
        options,
      )}`;
    },
    [intl],
  );

  /**
   * 统计骨骼节点、部件节点数量，以及是否有透明部件
   */
  const countModelUnits = useCallback(
    (
      editor: VoxelEditor,
      hierarchyData: HierarchyData,
      nodeAlphaCache?: NodeAlphaCache,
    ) => {
      let hasTransparentSkin = false;
      let faces = 0;

      const { nodeManager } = editor.animatorApp;

      const skinNodes = nodeManager.getAllSkinNodes();

      let skins = 0;

      skinNodes.forEach((skinNode) => {
        const nodeId = skinNode.uuid;
        const hierarchy = hierarchyData[nodeId];

        if (!hierarchy || hierarchy.type !== ProjectNodeType.SkinPart) {
          return;
        }

        skins++;

        if (!hasTransparentSkin) {
          let alpha: number = 1;
          if (nodeAlphaCache?.[nodeId] !== undefined) {
            alpha = nodeAlphaCache?.[nodeId];
          } else {
            alpha = hierarchy.alpha;
          }
          hasTransparentSkin = alpha < 1;
        }

        if (hierarchy.voxelId) {
          const voxelFaces =
            editor.voxelApp.voxelManager.updateMesherFaces(hierarchy.voxelId) ||
            0;

          faces += voxelFaces;
        }
      });

      return {
        skins,
        bones: nodeManager.getAllBoneNodes().length,
        faces,
        hasTransparentSkin,
      };
    },
    [],
  );

  const animatorProfile = useMemo(() => {
    if (mode !== AppMode.Animator || !editor) {
      return;
    }

    const { skins, bones, faces, hasTransparentSkin } = countModelUnits(
      editor,
      hierarchyData,
      nodeAlphaCache,
    );

    const activeBones = getActiveBoneIds(activeIds.concat(relativeIds)).length;

    const { voxelApp } = editor;

    const activeFaces = activeSkinPartIds
      .concat(relativeSkinPartIds)
      .reduce((total, nodeId) => {
        const node = hierarchyData[nodeId];

        let voxelFaces = 0;

        if (node && node.type === ProjectNodeType.SkinPart && node.voxelId) {
          voxelFaces =
            voxelApp.voxelManager.updateMesherFaces(node.voxelId) || 0;
        }

        return total + voxelFaces;
      }, 0);

    return {
      skins,
      activeSkins: activeSkinPartIds.length + relativeSkinPartIds.length,
      bones,
      faces,
      activeBones,
      hasTransparentSkin,
      activeFaces,
    };
  }, [
    mode,
    hierarchyData,
    activeIds,
    relativeIds,
    activeSkinPartIds,
    relativeSkinPartIds,
    editor,
    countModelUnits,
    nodeAlphaCache,
  ]);

  const animatorDataSet = useMemo<DataSet | undefined>(() => {
    if (!animatorProfile) {
      return [];
    }

    const {
      skins,
      faces,
      activeSkins,
      bones,
      activeBones,
      hasTransparentSkin,
      activeFaces,
    } = animatorProfile;

    return [
      {
        key: 'skins',
        name: intl.formatMessage({
          description: 'profile skins',
          defaultMessage: 'object',
        }),
        value: getGroupingFraction(activeSkins, skins),
      },
      {
        key: 'faces',
        name: intl.formatMessage({
          description: 'profile faces',
          defaultMessage: 'faces',
        }),
        value: getGroupingFraction(activeFaces, faces),
      },
      {
        key: 'bones',
        name: intl.formatMessage({
          description: 'profile bones',
          defaultMessage: 'bones',
        }),
        value: getGroupingFraction(activeBones, bones),
      },
      {
        key: 'hasTransparent',
        name: intl.formatMessage({
          description: 'profile hasTransparent',
          defaultMessage: 'transparent',
        }),
        value: intl.formatMessage(
          {
            description: 'profile hasTransparent value',
            // see: https://formatjs.github.io/docs/core-concepts/icu-syntax#select-format
            defaultMessage: `{
            hasTransparent, select,
              true {yes}
              other {no}
          }`,
          },
          {
            hasTransparent: hasTransparentSkin,
          },
        ),
      },
    ];
  }, [animatorProfile, intl, getGroupingFraction]);

  const children = useMemo(() => {
    const nodes: ReactNode[] = [];

    [animatorDataSet].forEach((dataSet) => {
      if (!dataSet) {
        return;
      }

      dataSet.forEach(({ key, name, value }) => {
        nodes.push(
          <p key={key}>{name}</p>,
          <p key={`${key}-value`}>{value}</p>,
        );
      });
    });

    return nodes;
  }, [animatorDataSet]);

  return <div className={styles.profilePanel}>{children}</div>;
}

export const ProfilePanel = memo(ProfilePanelView);
