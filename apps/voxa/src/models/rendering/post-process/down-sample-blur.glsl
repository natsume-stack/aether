precision mediump float;

uniform sampler2D pixels;
uniform vec2 shape;

void main() {
  vec2 uv = gl_FragCoord.xy / shape;
  vec2 duv = 0.5 / shape;
  vec4 color = 4.0 * texture2D(pixels, uv);
  color += texture2D(pixels, uv + vec2(duv.x, duv.y));
  color += texture2D(pixels, uv + vec2(-duv.x, duv.y));
  color += texture2D(pixels, uv + vec2(duv.x, -duv.y));
  color += texture2D(pixels, uv + vec2(-duv.x, -duv.y));
  gl_FragColor = color / 8.0;
}