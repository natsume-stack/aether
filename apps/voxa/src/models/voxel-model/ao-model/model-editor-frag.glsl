precision highp float;

#define PI 3.14159265

varying vec3 position;
varying vec4 color;
varying float lightness;

uniform vec3 eye;
uniform vec3 wireFrameColor;
uniform float showGrid;
varying float faceCode;

void main() {
  float ao = color.a;
  float light = 0.55 * (lightness + ao);
  vec3 c = light * color.rgb;
  if (showGrid < 1.0) {
    gl_FragColor = vec4(c, 1);
  } else {
    int n = int(floor(faceCode + 0.5));
    float threashod = 0.03 * 0.025 * length(eye - position);
    float x_delta = abs(floor(position.x + 0.5) - position.x);
    if (x_delta < threashod && n != 0 && n != 1) {
      float v0 = smoothstep(0., threashod, x_delta);
      float v = 1. - v0 * v0 * 0.5;
      c = mix(c, wireFrameColor, v*v * 0.85);
    }
    float y_delta = abs(floor(position.y + 0.5) - position.y);
    if (y_delta < threashod && n != 2 && n != 3 && n != 6) {
      float v0 = smoothstep(0., threashod , y_delta);
      float v = 1. - v0 * v0 * 0.5;
      c = mix(c, wireFrameColor, v*v * 0.85);
    }
    float z_delta = abs(floor(position.z + 0.5) - position.z);
    if (z_delta < threashod  && n != 4 && n != 5) {
      float v0 = smoothstep(0., threashod , z_delta);
      float v = 1. - v0 * v0 * 0.5;
      c = mix(c, wireFrameColor, v*v * 0.85);
    }
    gl_FragColor = vec4(c, 1);
  }
  return;
}
