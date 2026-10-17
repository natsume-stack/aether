#pragma glslify: getGridAlpha = require('./grid-alpha.glsl')

float getGridAlphas(vec3 resolution, vec3 pos, vec3 normal, vec3 df, float factor) {
  float alpha = 0.0;

  alpha += step(0.5, abs(normal.x)) * getGridAlpha(resolution.yz, pos.yz, df.yz, factor);

  alpha += step(0.5, abs(normal.y)) * getGridAlpha(resolution.xz, pos.xz, df.xz, factor);

  alpha += step(0.5, abs(normal.z)) * getGridAlpha(resolution.xy, pos.xy, df.xy, factor);

  return alpha;
}

#pragma glslify:export(getGridAlphas);
