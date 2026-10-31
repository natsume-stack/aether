precision highp float;

attribute vec4 s0, s1;

varying vec3 position;
varying vec3 normal;
varying vec4 color;
varying float lightness;

uniform bool inflate;

uniform mat4 projection, modelViewMatrix;
uniform float Lightness[7];
varying float faceCode;

vec3 decodeNormal(float code) {
  lowp float h0 = step(code, 0.5);
  lowp float h1 = step(code, 1.5);
  lowp float h2 = step(code, 2.5);
  lowp float h3 = step(code, 3.5);
  lowp float h4 = step(code, 4.5);

  vec3 rst = vec3(
    h1 - 2. * h0,
    h3 - 2. * h2 + h1,
    1. - 2. * h4 + h3);
  return rst;
}

void main() {
  faceCode = float(s1.a);
  lightness = Lightness[int(faceCode)];

  normal = decodeNormal(faceCode);
  vec3 rgb = s1.rgb;
  color = vec4(rgb, s0.a) / 255.;
  position = s0.xyz;
  vec3 pos = s0.xyz;
  faceCode = float(s1.a);
  if (inflate) {
    pos += vec3(0.01, 0.01, 0.01) * normal;
  }

  gl_Position = projection * modelViewMatrix * vec4(pos, 1);
}
