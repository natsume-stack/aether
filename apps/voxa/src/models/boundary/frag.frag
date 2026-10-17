#extension GL_OES_standard_derivatives : enable
precision highp float;

#pragma glslify: getGridAlphas = require('../rendering/shaders/grid-alphas.glsl')

uniform vec3 workspaceSize;
uniform bool showGrid;

varying vec3 vNormal;
varying vec3 pos;

float getAxisAlpha(vec2 posOnPlane, vec2 df, float factor) {
  vec2 alpha = smoothstep(factor * df, vec2(0.), posOnPlane);

  return max(alpha.x, alpha.y);
}

vec4 getAxisColor(vec4 currentColor, vec3 newColor, vec2 plane, vec2 df, float factor) {
  float a = getAxisAlpha(plane, df, factor);

  return (currentColor.a < 0.5 && a > currentColor.a) ? vec4(newColor, a) : currentColor;
}

void main() {
  vec3 df = fwidth(pos);
  float factor = 2.;
  vec4 color = vec4(0.);

  color = (vNormal.y > 0.5 || vNormal.z > 0.5) ? getAxisColor(color, vec3(0.91, 0.2, 0.2), pos.yz, df.yz, factor) : color;

  color = (vNormal.x > 0.5 || vNormal.z > 0.5) ? getAxisColor(color, vec3(0.2, 0.91, 0.27), pos.xz, df.xz, factor) : color;

  color = (vNormal.x > 0.5 || vNormal.y > 0.5) ? getAxisColor(color, vec3(0, 0.76, 1), pos.xy, df.xy, factor) : color;

  // 平滑边缘用的宽度系数,外边缘由于收到面的边缘影响，需要更大一些
  float a;
  a = getGridAlphas(workspaceSize, pos, vNormal, df, factor);

  color = (color.a < 0.5 && a > color.a) ? vec4(1, 1, 1, a) : color;

  // 绘制网格
  float gFactor = 1.5;

  // 10个一组的网格
  a = showGrid ? getGridAlphas(vec3(10.), pos, vNormal, df, gFactor) : a;

  color = (showGrid && color.a < 0.5 && a > color.a) ? vec4(vec3(0.4), a) : color;

  // 最小网格
  a = showGrid ? getGridAlphas(vec3(1.), pos, vNormal, df, gFactor) : a;

  color = (showGrid && color.a < 0.5 && a > color.a) ? vec4(vec3(1.), 0.12 * a) : color;

  gl_FragColor = color;
}
