precision mediump float;

uniform vec3 color;
uniform float alpha;

varying float vLineDistance;

void main() {
  float totalSize = 5.;
  float dashSize = 0.5 * totalSize;

  if(mod(vLineDistance, totalSize) > dashSize) {

    discard;

  }

  gl_FragColor = vec4(color, alpha);
}
