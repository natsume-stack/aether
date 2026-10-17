precision mediump float;

varying lowp vec4 color;
varying float lightness;
varying float emissive;
uniform float alpha;
uniform bool enableEmissive;

// 在地图中这个数值是100，exposure约等于emissive scale的倒数0.01
// （早上或傍晚6点的数值，根据光照条件exposure大约在0-0.1之间变化）
// 颜色会受到scale和exposure两者的影响，综合之下scale取值1接近地图中早晚6点的效果
#define EMISSIVE_SCALE 1.

void main() {
  float ao = color.a;
  float light = 0.55 * (lightness + ao);

  vec3 fragColor;
  if (emissive > 0.0 && enableEmissive) {
    fragColor = (light + 4. * EMISSIVE_SCALE * emissive) * color.rgb;
  } else {
    fragColor = light * color.rgb;
  }
  gl_FragColor = vec4(fragColor, alpha);
}
