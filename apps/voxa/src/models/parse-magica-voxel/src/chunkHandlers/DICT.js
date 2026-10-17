const readSTRING = require('./STRING');
const readROTATION = require('./ROTATION');

module.exports = function readDICT(Buffer, contentStartByteIndex) {
  var readByteIndex = contentStartByteIndex;
  var numKeys = Buffer.readInt32LE(readByteIndex);
  readByteIndex += 4;

  var result = {};
  var key, value;
  for (var i = 0; i < numKeys; ++i) {
    [key, readByteIndex] = readSTRING(Buffer, readByteIndex);
    [value, readByteIndex] = readSTRING(Buffer, readByteIndex);
    if (key === '_r') {
      value = readROTATION(+value);
    }
    result[key] = value;
  }

  return [result, readByteIndex];
};
