import type { ErrorResult, IResult, SuccessResult } from './interfaces';

function isResult<SuccessBody, ErrorBody>(
  res: any,
): res is IResult<SuccessBody, ErrorBody> {
  return res && typeof res.isSuccess === 'boolean';
}

/**
 * 判断是否为成功的结果
 */
export function ok<Body = undefined>(res: unknown): res is SuccessResult<Body> {
  return isResult(res) && res.isSuccess;
}

/**
 * 判断是否为失败的结果
 */
export function error<Body = undefined>(
  err: unknown,
): err is ErrorResult<Body> {
  return isResult(err) && !err.isSuccess;
}
