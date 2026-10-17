export type IResult<SuccessBody = undefined, ErrorBody = undefined> =
  | SuccessResult<SuccessBody>
  | ErrorResult<ErrorBody>;

export type SuccessResult<Body = undefined> = Body extends undefined
  ? { isSuccess: true }
  : { isSuccess: true; body: Body };

export type ErrorResult<Body = undefined> = Body extends undefined
  ? { isSuccess: false }
  : { isSuccess: false; body: Body };
