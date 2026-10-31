#extension GL_OES_standard_derivatives : enable
precision mediump float;

#pragma glslify: getGridAlphas = require('../rendering/shaders/grid-alphas.glsl')

uniform vec4 color;
uniform vec3 size;
varying vec3 pos;
varying vec3 vNormal;

void main() {
  vec3 df = fwidth(pos);
  gl_FragColor = vec4(color.rgb, getGridAlphas(size, pos, vNormal, df, 1.5) * color.a);
}
