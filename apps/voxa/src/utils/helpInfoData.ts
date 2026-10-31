export const infoType = {
  infoView:'infoView',
  attachTool:'attachTool',
  brushTool:'brushTool',
  eraseTool:'eraseTool',
  tubeTool:'tubeTool',
  selectTool:'selectTool',
  magicWand:'magicWand',
  translateTool:'translateTool',
  hollowOut: 'hollowOut',
  bucketTool: 'bucketTool',
  mirrorSymmetry: 'mirrorSymmetry',
  AxisExtend: 'AxisExtend',
  boxMode: 'boxMode',
  faceMode: 'faceMode',
  centerMode: 'centerMode',
  lineMode: 'lineMode',
  coloItem: 'coloItem',
  surfaceSelect: 'surfaceSelect',
  volumeSelect: 'volumeSelect',
  colorSelect: 'colorSelect',
};

export const InfoText = {
  infoView: {
    title: 'Info View',
    content: 'The Info View provides a brief description of the user interface element that the mouse currently over.  [?] Show/Hide info View',
  },

  attachTool: {
    title: 'Attach Tool',
    content: 'The Attact tool can build block, it have everal editing mode: box, face, center, line (show at header bar)',
  },

  brushTool: {
    title: 'Brush Tool',
    content: 'The Brush tool can paint selected color, it have everal editing mode: box, face, center, line (show at header bar)',
  },

  eraseTool: {
    title: 'Eraser Tool',
    content: 'The Eraser tool can erase block, it have everal editing mode: box, face, center, line (show at header bar)',
  },

  selectTool: {
    title: 'Select Tool',
    content: 'Select an area of blocks',
  },

  tubeTool: {
    title: 'Tube Tool',
    content: 'The Tube tool pick the color of the hit block, the picked color will be hightlighted in palette panel',
  },

  magicWand: {
    title: 'Magic Wand',
    content: 'The Magic Wand select the blocks that have same color index in certain area, it have three options: surface, volume, all (show at header bar)',
  },

  translateTool: {
    title: 'Translate Tool',
    content: 'The Translate tool can move the selected or unselected blocks in X/Y/Z direction depend on which type of blocks mouse hit on',
  },

  hollowOut: {
    title: 'Hollow Out',
    content: 'Remove all the blocks that have same color with the one that got hit',
  },

  bucketTool: {
    title: 'Bucket Tool',
    content: 'Paint all the blocks that have same color with the one that got hit',
  },

  mirrorSymmetry: {
    title: 'Mirror Symmetry',
    content: 'Build model in Mirror Symmetry alone with three axis, apply to Attach, Brush, Eraser, Select',
  },

  AxisExtend: {
    title: 'Axis',
    content: 'Apply to Attach, Brush, Eraser, Select',
  },

  boxMode: {
    title: 'Box mode',
    content: 'Edit a cuboid area',
  },

  faceMode: {
    title: 'Face mode',
    content: 'Edit in surface units',
  },

  centerMode: {
    title: 'Center mode',
    content: 'Edit in shape of circle or square',
  },

  lineMode: {
    title: 'Line mode',
    content: 'Edit in voxels line segment units',
  },

  coloItem: {
    title: 'Color item',
    content: 'Right click to show ColorPicker, left click will close ColorPicker',
  },

  surfaceSelect: {
    title: 'Surface select',
    content: 'Select all adjacent blocks with the same color as the hit block in hit surface',
  },

  volumeSelect: {
    title: 'Volume select',
    content: 'Select all adjacent blocks with the same color as the hit block in a volume',
  },

  colorSelect: {
    title: 'Color select',
    content: 'Select all the blocks with the same color as the hit block',
  },
};