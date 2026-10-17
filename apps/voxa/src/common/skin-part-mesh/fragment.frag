precision mediump float;

uniform float alpha;

uniform sampler2D texture;
varying highp vec2 _uv;

varying float lightness;

// 注释见的skinPartMesh
// 基于ao-mesher的skinPartMesh为1.0
// 这里没有ao的影响，适当提高系数
#define EMISSIVE_SCALE 2.

void main() {
  vec4 rgbe = texture2D(texture, _uv);

  // 根据skin-part-mesh中实现的发光计算
  float emissive = rgbe.a;

  // skin-part-mesh中，ao-mesher版本计算有ao参数，亮度更高，这里提高系数
  float light = 1.0 * lightness;

  vec3 fragColor = rgbe.rgb;

  if(emissive > 0.0) {
    fragColor = (light + 4. * EMISSIVE_SCALE * emissive) * fragColor.rgb;
  } else {
    fragColor = light * fragColor.rgb;
  }

  gl_FragColor = vec4(fragColor, alpha);
}