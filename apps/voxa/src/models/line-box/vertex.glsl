precision mediump float;

uniform mat4 projection, modelViewMatrix;

attribute vec3 position, normal;
varying vec3 pos;
varying vec3 vNormal;

void main() {
  pos = position;
  vNormal = normal;
  gl_Position = projection * vec4((modelViewMatrix * vec4(position, 1)).xyz, 1);
}
