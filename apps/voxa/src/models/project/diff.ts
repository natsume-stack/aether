import { ProjectDataSchema } from './defs';
import type { ProjectManager } from '.';
import { store } from '../../redux/store';
import { ProjectData } from './interfaces';

type Snapshot = {
  projectData: ProjectData;
  projectName: string;
};

export class ProjectDiffTool {
  /**
   * 工程文件的快照。用于对比是否有变化。
   */
  private snapshot?: Snapshot;

  constructor(private projectManager: ProjectManager) {}

  /**
   * 判断当前工程文件是否与上一次的快照是否不同
   */
  public async hasChanged() {
    const { projectName } = store.getState().app;
    const projectData = await this.projectManager.getData();

    if (!this.snapshot) {
      return true;
    }

    const {
      projectData: snapshotProjectData,
      projectName: snapshotProjectName,
    } = this.snapshot;

    return (
      snapshotProjectName !== projectName ||
      !ProjectDataSchema.equal(snapshotProjectData, projectData)
    );
  }

  /**
   * 更新工程文件的快照。
   */
  public setSnapshot(data: Snapshot) {
    this.snapshot = data;
  }

  /**
   * 更新工程文件的快照名
   */
  public setSnapshotName(name: string) {
    if (!this.snapshot) {
      return;
    }

    this.snapshot.projectName = name;
  }
}
