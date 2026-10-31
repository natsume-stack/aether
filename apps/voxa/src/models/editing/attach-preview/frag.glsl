precision mediump float;

uniform float alpha;
uniform vec3 eye;

varying vec3 vNormal;
varying vec3 vColor;
uniform float Lightness[7], tick;

void main() {
  vec3 color = vColor;

  if (vNormal.x < -0.5) {
    color *= Lightness[0];
  } else if (vNormal.x > 0.5) {
    color *= Lightness[1];
  } else if (vNormal.y < -0.5) {
    color *= Lightness[2];
  } else if (vNormal.y > 0.5) {
    color *= Lightness[3];
  } else if (vNormal.z < -0.5) {
    color *= Lightness[4];
  } else if (vNormal.z > 0.5) {
    color *= Lightness[5];
  }

  color = mix(color, vColor, 0.6);

  gl_FragColor = vec4(color, alpha);
}
