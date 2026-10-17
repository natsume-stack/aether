var readDICT = require('./DICT');

module.exports = function nTRNHandler(Buffer, contentStartByteIndex) {
  var readByteIndex = contentStartByteIndex;
  var nodeId = Buffer.readInt32LE(readByteIndex);
  readByteIndex += 4;

  var nodeAttributes;
  [nodeAttributes, readByteIndex] = readDICT(Buffer, readByteIndex);

  var childId = Buffer.readInt32LE(readByteIndex);
  readByteIndex += 4;

  // reserved
  readByteIndex += 4;

  var layerId = Buffer.readInt32LE(readByteIndex);
  readByteIndex += 4;

  var numFrames = Buffer.readInt32LE(readByteIndex);
  readByteIndex += 4;

  var frames = new Array(numFrames);
  for (var i = 0; i < frames.length; ++i) {
    [frames[i], readByteIndex] = readDICT(Buffer, readByteIndex);
  }

  return {
    id: nodeId,
    attributes: nodeAttributes,
    layerId: layerId,
    childId: childId,
    numFrames: numFrames,
    frames: frames,
  };
};
