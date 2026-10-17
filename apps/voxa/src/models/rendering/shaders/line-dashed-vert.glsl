precision mediump float;

uniform mat4 projection, modelViewMatrix;

attribute vec2 position;
attribute float lineDistance;

varying float vLineDistance;

void main() {
  vec3 pos = (modelViewMatrix * vec4(position.xy, 0, 1)).xyz;

  vLineDistance = lineDistance;

  gl_Position = projection * vec4(pos, 1);
}
