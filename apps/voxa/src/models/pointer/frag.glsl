precision mediump float;

uniform float u_time;

void main() {
  float pct = abs(sin(u_time));
  vec3 colorA = vec3(1., 1., 1.);
  vec3 colorB = vec3(0.5, 0.5, 0.5);

  gl_FragColor = vec4(mix(colorA, colorB, pct), 1.);
}
