const SIZEHandler = require('./chunkHandlers/SIZE');
const RGBAHandler = require('./chunkHandlers/RGBA');
const XYZIHandler = require('./chunkHandlers/XYZI');
const PACKHandler = require('./chunkHandlers/PACK');
const MATTHandler = require('./chunkHandlers/MATT');
const LAYRHandler = require('./chunkHandlers/LAYR');
const nTRNHandler = require('./chunkHandlers/nTRN');
const nGRPHandler = require('./chunkHandlers/nGRP');
const nSHPHandler = require('./chunkHandlers/nSHP');
const rOBJHandler = require('./chunkHandlers/rOBJ');
const chunkHandlers = {
  SIZE: SIZEHandler,
  XYZI: XYZIHandler,
  RGBA: RGBAHandler,
  PACK: PACKHandler,
  MATT: MATTHandler,
  LAYR: LAYRHandler,
  nTRN: nTRNHandler,
  nGRP: nGRPHandler,
  nSHP: nSHPHandler,
  rOBJ: rOBJHandler,
};

module.exports = function getChunkData(
  Buffer,
  id,
  definitionEndIndex,
  totalEndIndex,
) {
  if (!chunkHandlers[id]) {
    // throw "Unsupported chunk type " + id;
    return;
  }
  return chunkHandlers[id](Buffer, definitionEndIndex, totalEndIndex);
};
