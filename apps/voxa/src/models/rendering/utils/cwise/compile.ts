/**
 * CWise 编译器中负责编译的部分
 */
import { uniq } from 'ramda';
import type { BodyArgs, Procedure } from '.';

export type DTypes = 'generic';

/**
 * Generates a cwise operator
 * @param proc
 * @param typesig
 * @returns
 */
export function generateCWiseOp(proc: Procedure, typesig: DTypes[]) {
  //Compute dimension
  let dimension = typesig[1].length | 0;
  let orders = new Array(proc.arrayArgs.length);
  let dtypes: DTypes[] = new Array(proc.arrayArgs.length);

  //First create arguments for procedure
  let arglist = ['SS'];
  let code = ["'use strict'"];
  let vars: string[] = [];

  for (let j = 0; j < dimension; ++j) {
    vars.push(['s', j, '=SS[', j, ']'].join(''));
  }
  for (let i = 0; i < proc.arrayArgs.length; ++i) {
    arglist.push('a' + i);
    arglist.push('t' + i);
    arglist.push('p' + i);
    dtypes[i] = typesig[2 * i];
    orders[i] = typesig[2 * i + 1];
  }
  for (let i = 0; i < proc.scalarArgs.length; ++i) {
    arglist.push('Y' + i);
  }
  if (proc.shapeArgs.length > 0) {
    vars.push('shape=SS.slice(0)');
  }
  if (proc.indexArgs.length > 0) {
    let zeros = new Array(dimension);
    for (let i = 0; i < dimension; ++i) {
      zeros[i] = '0';
    }
    vars.push(['index=[', zeros.join(','), ']'].join(''));
  }
  for (let i = 0; i < proc.offsetArgs.length; ++i) {
    let off_arg = proc.offsetArgs[i];
    let init_string: string[] = [];
    for (let j = 0; j < off_arg.offset.length; ++j) {
      if (off_arg.offset[j] === 0) {
        continue;
      } else if (off_arg.offset[j] === 1) {
        init_string.push(['t', off_arg.array, '[', j, ']'].join(''));
      } else {
        init_string.push(
          [off_arg.offset[j], '*t', off_arg.array, '[', j, ']'].join(''),
        );
      }
    }
    if (init_string.length === 0) {
      vars.push('q' + i + '=0');
    } else {
      vars.push(['q', i, '=(', init_string.join('+'), ')|0'].join(''));
    }
  }

  //Prepare this variables
  let thisVars = uniq(
    []
      .concat(proc.pre.thisVars)
      .concat(proc.body.thisVars)
      .concat(proc.post.thisVars),
  );
  vars = vars.concat(thisVars);
  code.push('let ' + vars.join(','));
  for (let i = 0; i < proc.arrayArgs.length; ++i) {
    code.push('p' + i + '|=0');
  }

  //Inline prelude
  if (proc.pre.body.length > 3) {
    code.push(processBlock(proc.pre, proc, dtypes));
  }

  //Process body
  let body = processBlock(proc.body, proc, dtypes);
  let matched = countMatches(orders);
  if (matched < dimension) {
    code.push(outerFill(matched, orders[0], proc, body));
  } else {
    code.push(innerFill(orders[0], proc, body));
  }

  //Inline epilog
  if (proc.post.body.length > 3) {
    code.push(processBlock(proc.post, proc, dtypes));
  }

  if (proc.debug) {
    console.log(
      'Generated cwise routine for ',
      typesig,
      ':\n\n',
      code.join('\n'),
    );
  }

  let loopName = [
    proc.funcName || 'unnamed',
    '_cwise_loop_',
    orders[0].join('s'),
    'm',
    matched,
    typeSummary(dtypes),
  ].join('');
  let f = new Function(
    [
      'function ',
      loopName,
      '(',
      arglist.join(','),
      '){',
      code.join('\n'),
      '} return ',
      loopName,
    ].join(''),
  );
  return f();
}

/**
 * 根据参数生成对应的代码块，函数、变量名均会被替换
 * @param block
 * @param proc
 * @param dtypes
 * @returns
 */
function processBlock(block: BodyArgs, proc: Procedure, dtypes: DTypes[]) {
  let code = block.body;
  let pre: string[] = [];
  let post: string[] = [];

  for (let i = 0; i < block.args.length; ++i) {
    /**
     * Body Block 中的参数
     */
    let carg = block.args[i];
    if (carg.count <= 0) {
      continue;
    }

    /**
     * 当前参数对应的对象名的字符串正则
     */
    let re = new RegExp(carg.name, 'g');

    /**
     * 外层函数的参数Index，用来确认同位置上的外层 arg 是不是 array 类型，只有 array 类型时会向数组中推 i
     */
    let arrNum = proc.arrayArgs.indexOf(i);
    /**
     * 数组内指针的代码
     */
    let ptrStr = '';

    // 根据参数类型，替换传参中的对象名为可运行的对象名
    switch (proc.argTypes[i]) {
      case 'offset':
        let offArgIndex = proc.offsetArgIndex.indexOf(i);
        let offArg = proc.offsetArgs[offArgIndex];
        arrNum = offArg.array;
        ptrStr = '+q' + offArgIndex;
      case 'array':
        ptrStr = 'p' + arrNum + ptrStr;
        let localStr = 'l' + i;
        /**
         * 当前参数所代表数组的对应变量
         */
        let arrStr = 'a' + arrNum;
        if (carg.count === 1) {
          if (dtypes[arrNum] === 'generic') {
            if (carg.lvalue) {
              pre.push(
                ['let ', localStr, '=', arrStr, '.get(', ptrStr, ')'].join(''),
              );
              code = code.replace(re, localStr);
              post.push([arrStr, '.set(', ptrStr, ',', localStr, ')'].join(''));
            } else {
              code = code.replace(re, [arrStr, '.get(', ptrStr, ')'].join(''));
            }
          } else {
            code = code.replace(re, [arrStr, '[', ptrStr, ']'].join(''));
          }
        } else if (dtypes[arrNum] === 'generic') {
          pre.push(
            ['let ', localStr, '=', arrStr, '.get(', ptrStr, ')'].join(''),
          );
          code = code.replace(re, localStr);
          if (carg.lvalue) {
            post.push([arrStr, '.set(', ptrStr, ',', localStr, ')'].join(''));
          }
        } else {
          pre.push(['let ', localStr, '=', arrStr, '[', ptrStr, ']'].join(''));
          code = code.replace(re, localStr);
          if (carg.lvalue) {
            post.push([arrStr, '[', ptrStr, ']=', localStr].join(''));
          }
        }
        break;
      case 'scalar':
        code = code.replace(re, 'Y' + proc.scalarArgs.indexOf(i));
        break;
      case 'index':
        code = code.replace(re, 'index');
        break;
      case 'shape':
        code = code.replace(re, 'shape');
        break;
    }
  }
  return [pre.join('\n'), code, post.join('\n')].join('\n').trim();
}

function innerFill(order, proc, body) {
  var dimension = order.length,
    nargs = proc.arrayArgs.length,
    has_index = proc.indexArgs.length > 0,
    code: string[] = [],
    vars: string[] = [],
    idx = 0,
    pidx = 0,
    i,
    j;
  for (i = 0; i < dimension; ++i) {
    vars.push(['i', i, '=0'].join(''));
  }
  //Compute scan deltas
  for (j = 0; j < nargs; ++j) {
    for (i = 0; i < dimension; ++i) {
      pidx = idx;
      idx = order[i];
      if (i === 0) {
        vars.push(['d', j, 's', i, '=t', j, '[', idx, ']'].join(''));
      } else {
        vars.push(
          [
            'd',
            j,
            's',
            i,
            '=(t',
            j,
            '[',
            idx,
            ']-s',
            pidx,
            '*t',
            j,
            '[',
            pidx,
            '])',
          ].join(''),
        );
      }
    }
  }
  code.push('var ' + vars.join(','));
  //Scan loop
  for (i = dimension - 1; i >= 0; --i) {
    idx = order[i];
    code.push(['for(i', i, '=0;i', i, '<s', idx, ';++i', i, '){'].join(''));
  }
  //Push body of inner loop
  code.push(body);
  //Advance scan pointers
  for (i = 0; i < dimension; ++i) {
    pidx = idx;
    idx = order[i];
    for (j = 0; j < nargs; ++j) {
      code.push(['p', j, '+=d', j, 's', i].join(''));
    }
    if (has_index) {
      if (i > 0) {
        code.push(['index[', pidx, ']-=s', pidx].join(''));
      }
      code.push(['++index[', idx, ']'].join(''));
    }
    code.push('}');
  }
  return code.join('\n');
}

function outerFill(matched: number, order, proc, body) {
  var dimension = order.length,
    nargs: number = proc.arrayArgs.length,
    blockSize = proc.blockSize,
    has_index = proc.indexArgs.length > 0,
    code: string[] = [];
  for (var i = 0; i < nargs; ++i) {
    code.push(['var offset', i, '=p', i].join(''));
  }
  //Generate matched loops
  for (var i = matched; i < dimension; ++i) {
    code.push(
      ['for(var j' + i + '=SS[', order[i], ']|0;j', i, '>0;){'].join(''),
    );
    code.push(['if(j', i, '<', blockSize, '){'].join(''));
    code.push(['s', order[i], '=j', i].join(''));
    code.push(['j', i, '=0'].join(''));
    code.push(['}else{s', order[i], '=', blockSize].join(''));
    code.push(['j', i, '-=', blockSize, '}'].join(''));
    if (has_index) {
      code.push(['index[', order[i], ']=j', i].join(''));
    }
  }
  for (var i = 0; i < nargs; ++i) {
    var indexStr = ['offset' + i];
    for (var j = matched; j < dimension; ++j) {
      indexStr.push(['j', j, '*t', i, '[', order[j], ']'].join(''));
    }
    code.push(['p', i, '=(', indexStr.join('+'), ')'].join(''));
  }
  code.push(innerFill(order, proc, body));
  for (var i = matched; i < dimension; ++i) {
    code.push('}');
  }
  return code.join('\n');
}

//Count the number of compatible inner orders
function countMatches(orders) {
  var matched = 0,
    dimension = orders[0].length;
  while (matched < dimension) {
    for (var j = 1; j < orders.length; ++j) {
      if (orders[j][matched] !== orders[0][matched]) {
        return matched;
      }
    }
    ++matched;
  }
  return matched;
}

function typeSummary(dtypes) {
  var summary = new Array(dtypes.length);
  var allEqual = true;
  for (var i = 0; i < dtypes.length; ++i) {
    var t = dtypes[i];
    var digits = t.match(/\d+/);
    if (!digits) {
      digits = '';
    } else {
      digits = digits[0];
    }
    if (t.charAt(0) === 0) {
      summary[i] = 'u' + t.charAt(1) + digits;
    } else {
      summary[i] = t.charAt(0) + digits;
    }
    if (i > 0) {
      allEqual = allEqual && summary[i] === summary[i - 1];
    }
  }
  if (allEqual) {
    return summary[0];
  }
  return summary.join('');
}
