precision mediump float;

uniform mat4 projection, modelViewMatrix;

attribute vec3 position;
varying vec3 pos;

void main() {
  pos = position;
  gl_Position = projection * vec4((modelViewMatrix * vec4(position, 1)).xyz, 1);
}
