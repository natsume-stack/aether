precision mediump float;

uniform mat4 projection, modelViewMatrix;
uniform highp vec2 textureShape;

attribute mediump vec4 s0;
attribute highp vec2 uv;

varying highp vec2 _uv;

uniform float Lightness[7];
varying float lightness;

void main() {
    vec3 pos = (modelViewMatrix * vec4(s0.xyz, 1)).xyz;

    gl_Position = projection * vec4(pos, 1);

    // compute uv
    _uv = uv / textureShape;

    // compute lightness
    // Lightness为一个定值数组，根据不同的面渲染不同的阴影
    // 达到一个伪光照效果
    lightness = Lightness[int(s0.a)];
}
