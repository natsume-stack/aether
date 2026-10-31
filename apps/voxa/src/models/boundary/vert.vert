precision highp float;

attribute vec3 position, normal;
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 pos;
varying vec4 cutPos;
uniform mat4 projection, view, model;
uniform vec3 color;

void main() {
  vNormal = normal;
  pos = position;
  vec4 worldSpacePosition;

  worldSpacePosition = vec4(position, 1);
  cutPos = projection * view * model * worldSpacePosition;

  gl_Position = cutPos;
  vColor = color;
}