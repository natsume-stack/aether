import { HierarchyData, ProjectNodeType } from '../../redux/animator-slice';
import { NodeAlphaCache, setNodeAlphaCache } from '../../redux/app-slice';
import { store } from '../../redux/store';

export class VoxaProfiler {
  public updateSkinAlphaCache(ids: string[], hierarchyData: HierarchyData) {
    const skinAlphaCache = ids.reduce<NodeAlphaCache>((prev, curId) => {
      const skinNode = hierarchyData[curId];

      if (skinNode && skinNode.type === ProjectNodeType.SkinPart) {
        prev[curId] = skinNode.alpha;
      }

      return prev;
    }, {});

    store.dispatch(setNodeAlphaCache(skinAlphaCache));
  }

  public clearSkinAlphaCache() {
    store.dispatch(setNodeAlphaCache(undefined));
  }
}
