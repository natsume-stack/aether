precision mediump float;

varying vec2 uv;
uniform vec2 shape;
uniform sampler2D blurBuffers[3];

void main() {
  vec4 result = vec4(0.);
  vec2 duv = 0.5 / shape;
  for (int i = 0; i < 3; ++i) {
    duv *= 4.0;
    vec4 color = 4.0 * texture2D(blurBuffers[i], uv);
    color += texture2D(blurBuffers[i], uv + vec2(duv.x, duv.y));
    color += texture2D(blurBuffers[i], uv + vec2(-duv.x, duv.y));
    color += texture2D(blurBuffers[i], uv + vec2(duv.x, -duv.y));
    color += texture2D(blurBuffers[i], uv + vec2(-duv.x, -duv.y));
    result += color / 8.0;
  }
  gl_FragColor = result;
}