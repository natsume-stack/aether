precision highp float;

attribute vec3 position;
uniform mat4 projection, modelViewMatrix;

void main() {
  gl_Position = projection * modelViewMatrix * vec4(position, 1);
}
