var readDict = require('./DICT');

module.exports = function rOBJHandler(Buffer, contentStartByteIndex) {
  var ret = {};

  // DICT node attributes
  ret = readDict(Buffer, contentStartByteIndex);
  return ret;
};
