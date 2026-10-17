precision mediump float;

uniform mat4 projection, modelViewMatrix;
uniform float Lightness[7];
attribute mediump vec4 s0, s1;
attribute mediump float s2;

varying float lightness;
varying lowp vec4 color;
varying float emissive;

void main() {
  // compute lightness
  // Lightness为一个定值数组，根据不同的面渲染不同的阴影
  // 达到一个伪光照效果
  lightness = Lightness[int(s1.a)];

  // s0.a为AO，不是透明度
  // 透明度可以直接从外部传入到片元着色器
  color = vec4(s1.rgb, s0.a) / 255.0;

  emissive = 0.01 * s2;

  vec3 position = (modelViewMatrix * vec4(s0.xyz, 1)).xyz;
  gl_Position = projection * vec4(position, 1.0);
}
