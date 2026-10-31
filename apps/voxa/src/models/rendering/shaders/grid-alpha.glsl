float getGridAlpha(vec2 resolution, vec2 posOnPlane, vec2 df, float factor) {
  // Pos 在网格单元中的相对位置
  vec2 relativePos = fract(posOnPlane / resolution);

  // 靠近 0 值边缘的点的颜色
  vec2 lowAlpha = smoothstep(factor * df, vec2(0.), resolution * relativePos);

  vec2 highAlpha = smoothstep(factor * df, vec2(0.), resolution * abs(vec2(1.) - relativePos));

  float alpha = max(max(lowAlpha.x, lowAlpha.y), max(highAlpha.x, highAlpha.y));

  return alpha;
}

#pragma glslify:export(getGridAlpha)
