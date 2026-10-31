import { createTool, EventsType } from '@box/sdk';

export class IframeTool {
  private tool = createTool<EventsType, EventsType>();
  private connection: Promise<boolean>;

  constructor() {
    this.connection = this.tool.connect(() => {});
  }

  public emitLoadEvent() {
    this.connection.then((isReady) => {
      isReady && this.tool.emitEvent('loaded');
    });
  }
}
