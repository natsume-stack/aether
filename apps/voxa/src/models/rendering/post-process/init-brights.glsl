precision mediump float;

varying vec2 uv;
uniform sampler2D pixels;
uniform float blurNum;

void main() {
  vec3 color = 0.5 * texture2D(pixels, uv).rgb;
  vec3 bright = smoothstep(vec3(1.0), vec3(5.), color);
  float weight = max(max(bright.r, bright.g), bright.b) * (1. / (blurNum - 1.));
  gl_FragColor = vec4(color * weight, 1);
}