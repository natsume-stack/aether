module.exports = function readString(buffer, contentStartByteIndex) {
  var readByteIndex = contentStartByteIndex;
  var strLen = buffer.readInt32LE(readByteIndex);
  readByteIndex += 4;
  return [
    buffer.toString('ascii', readByteIndex, readByteIndex + strLen),
    readByteIndex + strLen,
  ];
};
