precision highp float;

uniform mediump sampler2D color;
uniform mediump vec2 shape;
uniform lowp sampler2D bloom;
uniform bool bloomEnabled;

uniform bool ssaoEnabled;
uniform lowp sampler2D ssao;

mediump vec4 fetchColor(mediump vec2 uv) {
  return texture2D(color, uv / shape);
}

void main() {
  mediump vec2 uv = gl_FragCoord.xy;
  mediump vec4 centerColor = fetchColor(uv);

  mediump vec3 fragColor = centerColor.rgb;

  if(ssaoEnabled) {
    float occlusion = 0.;
    for(int i = -2; i <= 2; i++) {
      for(int j = -2; j <= 2; j++) {
        occlusion += texture2D(ssao, (uv + vec2(i, j)) / shape).r;
      }
    }
    fragColor = centerColor.rgb * (occlusion / 25.);
  }

  if(bloomEnabled) {
    fragColor += 0.7 * texture2D(bloom, uv / shape).rgb;
  }

  gl_FragColor = vec4(fragColor, centerColor.a);
}