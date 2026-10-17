/**
 * CWISE 计算函数的编译器
 * https://github.com/scijs/cwise-compiler
 * https://github.com/scijs/cwise
 *
 */

import { generateCWiseOp } from './compile';

export class Procedure {
  public argTypes: (string | ArgObject)[] = [];
  /**
   * 全部参数
   */
  public shimArgs: string[] = [];
  /**
   * Array 类型参数索引
   */
  public arrayArgs: number[] = [];
  /**
   * Scalar 类型参数索引
   */
  public scalarArgs: number[] = [];
  public offsetArgs: ArgObject[] = [];
  public offsetArgIndex: number[] = [];
  public indexArgs: number[] = [];
  public shapeArgs: number[] = [];
  public funcName: string = '';

  public blockSize?: number;
  public debug = false;

  constructor(public pre, public body: BodyArgs, public post) {}
}

export type ArgObject = {
  array: number;
  offset: number[];
};

export type BodyArgs = {
  args: {
    name: string;
    count: number;
    lvalue: string | boolean;
    rvalue: string | boolean;
  }[];
  body: string;
  thisVars: [];
  localVars: [];
};

type UserArgs = {
  pre: unknown;
  /**
   * 内层 Body Block 的参数，其中 args 类型直接从外层 args 中读取
   */
  body: BodyArgs;
  post: unknown;
  args: (string | ArgObject)[];
  printCode?: unknown;
  debug?: boolean;
  funcName?: string;
  blockSize?: number;
};

/**
 * 编译针对 NDArray 使用的 component-wised 函数
 * @param user_args
 * @returns cwise function
 */
export function compileCwise(user_args: UserArgs) {
  //Create procedure
  const proc = new Procedure(user_args.pre, user_args.body, user_args.post);

  //Parse arguments
  const proc_args = user_args.args.slice(0);
  proc.argTypes = proc_args.slice(0);
  for (let i = 0; i < proc_args.length; ++i) {
    const arg_type = proc_args[i];
    if (arg_type === 'array') {
      proc.arrayArgs.push(i);
      proc.shimArgs.push('array' + i);
      if (i < proc.pre.args.length && proc.pre.args[i].count > 0) {
        throw new Error('cwise: pre() block may not reference array args');
      }
      if (i < proc.post.args.length && proc.post.args[i].count > 0) {
        throw new Error('cwise: post() block may not reference array args');
      }
    } else if (arg_type === 'scalar') {
      proc.scalarArgs.push(i);
      proc.shimArgs.push('scalar' + i);
    } else if (arg_type === 'index') {
      proc.indexArgs.push(i);
      if (i < proc.pre.args.length && proc.pre.args[i].count > 0) {
        throw new Error('cwise: pre() block may not reference array index');
      }
      if (i < proc.body.args.length && proc.body.args[i].lvalue) {
        throw new Error('cwise: body() block may not write to array index');
      }
      if (i < proc.post.args.length && proc.post.args[i].count > 0) {
        throw new Error('cwise: post() block may not reference array index');
      }
    } else if (arg_type === 'shape') {
      proc.shapeArgs.push(i);
      if (i < proc.pre.args.length && proc.pre.args[i].lvalue) {
        throw new Error('cwise: pre() block may not write to array shape');
      }
      if (i < proc.body.args.length && proc.body.args[i].lvalue) {
        throw new Error('cwise: body() block may not write to array shape');
      }
      if (i < proc.post.args.length && proc.post.args[i].lvalue) {
        throw new Error('cwise: post() block may not write to array shape');
      }
    } else if (typeof arg_type === 'object' && arg_type.offset) {
      proc.argTypes[i] = 'offset';
      proc.offsetArgs.push({ array: arg_type.array, offset: arg_type.offset });
      proc.offsetArgIndex.push(i);
    } else {
      throw new Error('cwise: Unknown argument type ' + proc_args[i]);
    }
  }

  //Make sure at least one array argument was specified
  if (proc.arrayArgs.length <= 0) {
    throw new Error('cwise: No array arguments specified');
  }

  //Make sure arguments are correct
  if (proc.pre.args.length > proc_args.length) {
    throw new Error('cwise: Too many arguments in pre() block');
  }
  if (proc.body.args.length > proc_args.length) {
    throw new Error('cwise: Too many arguments in body() block');
  }
  if (proc.post.args.length > proc_args.length) {
    throw new Error('cwise: Too many arguments in post() block');
  }

  //Check debug flag
  proc.debug = !!user_args.printCode || !!user_args.debug;

  //Retrieve name
  proc.funcName = user_args.funcName || 'cwise';

  //Read in block size
  proc.blockSize = user_args.blockSize || 64;

  return createThunk(proc);
}

/**
 * 生成一个在运行时按需生成目标函数的函数
 * @param proc
 * @returns
 */
function createThunk(proc: Procedure) {
  let code = ["'use strict'", 'let CACHED={}'];
  /**
   * 定义变量的代码
   */
  let vars: string[] = [];
  let thunkName = proc.funcName + '_cwise_thunk';

  // Build thunk 构建函数参数声明
  code.push(
    ['return function ', thunkName, '(', proc.shimArgs.join(','), '){'].join(
      '',
    ),
  );

  /**
   * 本地变量集合，会被带入Operator
   */
  let typesig: string[] = [];
  let string_typesig: string[] = [];
  /**
   * 传入目标函数的参数
   */
  let proc_args = [['array', proc.arrayArgs[0], '.shape'].join('')]; // 大家shape都一样，所以取第一个
  for (let i = 0; i < proc.arrayArgs.length; ++i) {
    let j = proc.arrayArgs[i];
    // 生成代表数组数据的变量， arrayX=TypedArray tX=dtype rX=order
    vars.push(
      ['t', j, '=array', j, '.dtype,', 'r', j, '=array', j, '.order'].join(''),
    );
    typesig.push('t' + j);
    typesig.push('r' + j);
    string_typesig.push('t' + j);
    string_typesig.push('r' + j + '.join()');
    proc_args.push('array' + j + '.data');
    proc_args.push('array' + j + '.stride');
    proc_args.push('array' + j + '.offset|0');
  }
  for (let i = 0; i < proc.scalarArgs.length; ++i) {
    // 生成代表 scalar 的变量，scalarX
    proc_args.push('scalar' + proc.scalarArgs[i]);
  }
  vars.push(['type=[', string_typesig.join(','), '].join()'].join(''));
  vars.push('proc=CACHED[type]');
  code.push('let ' + vars.join(','));

  code.push(
    [
      'if(!proc){',
      'CACHED[type]=proc=compile([',
      typesig.join(','),
      '])}',
      'return proc(',
      proc_args.join(','),
      ')}',
    ].join(''),
  );

  if (proc.debug) {
    console.log('Generated thunk:', code.join('\n'));
  }

  //Compile thunk as function thunk(compile)
  let thunk = new Function('compile', code.join('\n'));

  // Return function return by thunk
  return thunk(generateCWiseOp.bind(undefined, proc));
}
