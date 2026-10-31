import {
  colorSelectOptions,
  CenterModeOption,
  FaceModeColorOption,
  FaceModeSelectOption,
} from '@box/utils/helper';

export interface MetaHashProps {
  modelProjectHash: string;
  name: string;
  previewHash: string;
  contentId?: number;
  describe?: string;
}

export class VEState {
  public projectLoading = false;

  public gameEditorSource: Window | MessagePort | null = null;
  public gameEditorOrigin: string | null = null;

  public loadProjectInfo: any = null;

  public bg = {
    cA: [0.2, 0.2, 0.3],
    cB: [0.85, 0.85, 0.85],
  };

  public bgSchemes = [
    [
      [0.2, 0.2, 0.3],
      [0.85, 0.85, 0.85],
    ],
    [
      [0.21, 0.21, 0.21],
      [0.85, 0.85, 0.85],
    ],
    [[41, 148, 233].map((v) => v / 255), [255, 135, 126].map((v) => v / 255)],
    [[220, 156, 119].map((v) => v / 255), [255, 175, 189].map((v) => v / 255)],
    [[44, 62, 80].map((v) => v / 255), [189, 195, 199].map((v) => v / 255)],
    [[0, 4, 40].map((v) => v / 255), [0, 78, 146].map((v) => v / 255)],
    [[67, 206, 162].map((v) => v / 255), [24, 90, 157].map((v) => v / 255)],
    [[51, 8, 103].map((v) => v / 255), [48, 207, 208].map((v) => v / 255)],
    [[245, 247, 250].map((v) => v / 255), [195, 207, 226].map((v) => v / 255)],
    [[173, 87, 108].map((v) => v / 255), [255, 177, 153].map((v) => v / 255)],
    [[208, 227, 255].map((v) => v / 255), [243, 231, 233].map((v) => v / 255)],
    [[243, 144, 79].map((v) => v / 255), [59, 67, 113].map((v) => v / 255)],
  ];

  public projectInfo = {
    content_id: -1,
    dispaly_name: 'new_model',
    author: -1,
    description: '',
    preview: '',
  };

  public timeFreeze = false;
  public timeOfDay = 4 / 24;
  public lunarPhase = 0;
  public updateEnvTime() {
    this.timeOfDay += 0.001;
    this.lunarPhase += 0.001 / 24.0 / 2.0;
  }

  public viewConfig = {
    boundaryCheckboard: false,
  };

  // NEVER BEEN CHANGED
  // false的情况即为默认的编辑器背景
  public terrainMode: boolean = false;

  public pbrPreviewMode: boolean = false;

  public previewMeshMode: boolean = false;
  //   public guest3DPreview:boolean = false;

  private _faceModeColorOpt = FaceModeColorOption.currentColor;

  private _faceModeSelectionOpt = FaceModeSelectOption.colorGeometry;

  public basicActionOption = {
    /**
     * @deprecated this mode is no longer in use
     * TODO: remove it after confirmed
     */
    Axis: {
      X: false,
      Y: false,
      Z: false,
    },
  };

  private _previewList: MetaHashProps[] = [];

  private _dialogState = {
    show: false,
    dialog: dialogType.none,
  };

  private _currentCenterMode: CenterModeOption = CenterModeOption.circle;

  private _colorSelectOptions: colorSelectOptions = colorSelectOptions.face;

  constructor() {}

  public getFaceModeSelectionOpt() {
    return this._faceModeSelectionOpt;
  }

  public setFaceModeSelectionOpt(option: FaceModeSelectOption) {
    this._faceModeSelectionOpt = option;
  }

  public getCenterMode() {
    return this._currentCenterMode;
  }

  public setCenterMode(mode: CenterModeOption) {
    this._currentCenterMode = mode;
  }

  public setColorSelectOption(option: colorSelectOptions) {
    this._colorSelectOptions = option;
  }

  public getColorSelectOption() {
    return this._colorSelectOptions;
  }

  public getFaceModeColorOpt() {
    return this._faceModeColorOpt;
  }

  public setFaceModeColorOpt(option: FaceModeColorOption) {
    this._faceModeColorOpt = option;
  }

  public setDialogState(param: { show: boolean; dialog: dialogType }) {
    this._dialogState.show = param.show;
    this._dialogState.dialog = param.dialog;
  }

  public getDialogState(): {
    show: boolean;
    dialog: dialogType;
  } {
    return this._dialogState;
  }

  public getPreviewList() {
    return this._previewList;
  }

  public setPreviewList(data) {
    this._previewList = [];
    this._previewList = this._previewList.concat(data);
  }

  public removePreviewListItemById(contentId) {
    for (let i = 0; i < this._previewList.length; i++) {
      if (
        this._previewList[i].contentId !== undefined &&
        this._previewList[i].contentId === contentId
      ) {
        this._previewList.splice(i, 1);
        break;
      }
    }
  }
}

export enum dialogType {
  colorPicker,
  importImgDialog,
  none,
}
