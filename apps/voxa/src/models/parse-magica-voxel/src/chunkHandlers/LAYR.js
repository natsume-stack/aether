const readDict = require('./DICT');

module.exports = function LAYRHandler(Buffer, contentStartByteIndex) {
  var readByteIndex = contentStartByteIndex;
  var ret = {};

  // node id
  ret.id = Buffer.readInt32LE(readByteIndex);
  readByteIndex += 4;

  // DICT node attributes
  [ret.attributes, readByteIndex] = readDict(Buffer, readByteIndex);

  ret.reserved_id = Buffer.readInt32LE(readByteIndex);
  readByteIndex += 4;

  return ret;
};
