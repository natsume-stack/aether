import createREGL, { Regl } from '@box/regl';

export async function initRegl(canvas: HTMLCanvasElement): Promise<Regl> {
  return new Promise((res) => {
    const regl = createREGL({
      extensions: ['OES_element_index_uint', 'OES_standard_derivatives'],
      optionalExtensions: [
        'OES_texture_float',
        'EXT_color_buffer_float',
        'OES_texture_float_linear',
        'OES_texture_half_float',
        'EXT_color_buffer_half_float',
        'OES_texture_half_float_linear',
        'OES_vertex_array_object',
        'WEBGL_depth_texture',
        'EXT_shader_texture_lod',
        'EXT_disjoint_timer_query',
      ],
      attributes: {
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
      },
      onDone(err, regl) {
        if (err || !regl) {
          throw err;
        }

        res(regl);
      },
      canvas,
    });

    // 以下代码请确保不会进入生产环境
    if (process.env.NODE_ENV === 'development') {
      (window as any).regl = regl;
    }
  });
}
