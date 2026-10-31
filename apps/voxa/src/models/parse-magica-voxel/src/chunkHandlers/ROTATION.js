module.exports = function readROTATION(code) {
  const matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  var u = code & 3;
  var v = (code >> 2) & 3;
  var s0 = code & (1 << 4) ? -1 : 1;
  var s1 = code & (1 << 5) ? -1 : 1;
  var s2 = code & (1 << 6) ? -1 : 1;

  matrix[u] = s0;
  matrix[3 + v] = s1;
  matrix[6 + (3 ^ u ^ v)] = s2;

  return matrix;
};
