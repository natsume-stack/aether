precision mediump float;

uniform mat4 projection, modelViewMatrix;

attribute vec3 position;

void main() {
  vec3 pos = (modelViewMatrix * vec4(position, 1)).xyz;

  gl_Position = projection * vec4(pos, 1);
}
