#extension GL_OES_standard_derivatives : enable
precision mediump float;

#pragma glslify: getGridAlpha = require('../rendering/shaders/grid-alpha.glsl')

uniform float size, gridSize;
varying vec3 pos;

void main() {
  vec3 df = fwidth(pos);
  float gFactor = 1.5;
  float grid = getGridAlpha(vec2(gridSize), pos.xy, df.xy, gFactor) * 0.08;
  vec4 color = vec4(1, 1, 1, grid);

  float xA = getGridAlpha(vec2(size), pos.yz, df.yz, gFactor);
  color = xA > 0.0 ? vec4(0.91, 0.2, 0.2, xA) : color;
  // 视觉上的平面为xz平面
  // 实际上为xy平面绕x轴旋转90°，因此z轴指示线需要画在原本的y轴上
  float zA = getGridAlpha(vec2(size), pos.xz, df.xz, gFactor);
  color = zA > 0.0 ? vec4(0, 0.76, 1, zA) : color;

  gl_FragColor = color;
}
