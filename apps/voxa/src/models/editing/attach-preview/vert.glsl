precision mediump float;

attribute vec3 position, normal;

varying vec3 vNormal;
varying vec3 vColor;

uniform vec3 color;
uniform mat4 projection, modelViewMatrix;

void main() {
  vNormal = normal;

  vec4 pos;

  pos = vec4(position - vNormal * 0.003 , 1);

  gl_Position = projection * modelViewMatrix * pos;

  vColor = color;
}