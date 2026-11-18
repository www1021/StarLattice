/**
 * 24 点的表达式解析。只认数字、+ − × ÷ 和括号，别的字符直接判非法——
 * 不碰 eval / Function，学生输入什么都只当算术式。
 */

export type ExprResult =
  | { ok: true; value: number; numbers: number[] }
  | { ok: false; error: string };

function tokenize(input: string): string[] | null {
  const text = input.replace(/×/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-").replace(/\s+/g, "");
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/[0-9]/.test(char)) {
      let end = index;
      while (end < text.length && /[0-9]/.test(text[end])) {
        end += 1;
      }
      tokens.push(text.slice(index, end));
      index = end;
      continue;
    }
    if ("+-*/()".includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  /** 表达式里出现过的数字，按出现顺序记下来，用来核对「四个数各用一次」。 */
  numbers: number[] = [];

  constructor(private readonly tokens: string[]) {}

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private eat(token: string): boolean {
    if (this.peek() === token) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parse(): number {
    const value = this.expression();
    if (this.pos !== this.tokens.length) {
      throw new Error("式子后面还有没算完的部分");
    }
    return value;
  }

  private expression(): number {
    let value = this.term();
    for (;;) {
      if (this.eat("+")) {
        value += this.term();
      } else if (this.eat("-")) {
        value -= this.term();
      } else {
        return value;
      }
    }
  }

  private term(): number {
    let value = this.factor();
    for (;;) {
      if (this.eat("*")) {
        value *= this.factor();
      } else if (this.eat("/")) {
        const divisor = this.factor();
        if (Math.abs(divisor) < 1e-9) {
          throw new Error("不能除以 0");
        }
        value /= divisor;
      } else {
        return value;
      }
    }
  }

  private factor(): number {
    if (this.eat("-")) {
      return -this.factor();
    }
    if (this.eat("+")) {
      return this.factor();
    }
    if (this.eat("(")) {
      const value = this.expression();
      if (!this.eat(")")) {
        throw new Error("括号没配对");
      }
      return value;
    }
    const token = this.peek();
    if (token && /^\d+$/.test(token)) {
      this.pos += 1;
      const value = Number(token);
      this.numbers.push(value);
      return value;
    }
    throw new Error("这里缺一个数字");
  }
}

export function evaluateExpression(input: string): ExprResult {
  const tokens = tokenize(input);
  if (!tokens || tokens.length === 0) {
    return { ok: false, error: "只能填数字和 + − × ÷ 括号" };
  }
  const parser = new Parser(tokens);
  try {
    const value = parser.parse();
    return { ok: true, value, numbers: parser.numbers };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "这个式子算不了" };
  }
}

const round = (value: number) => (Math.abs(value - Math.round(value)) < 1e-9 ? String(Math.round(value)) : value.toFixed(2));

/** 校验一局 24 点：结果等于 24，且给定的四个数各用了一次。 */
export function verifyTwentyFour(
  input: string,
  numbers: number[]
): { ok: boolean; error?: string; value?: number } {
  const result = evaluateExpression(input);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  if (Math.abs(result.value - 24) > 1e-6) {
    return { ok: false, error: `这个式子算出来是 ${round(result.value)}，不是 24。`, value: result.value };
  }
  const used = [...result.numbers].sort((left, right) => left - right).join(",");
  const target = [...numbers].sort((left, right) => left - right).join(",");
  if (used !== target) {
    return {
      ok: false,
      error: `这副牌是 ${numbers.join("、")}，每个都要用一次，不能重复也不能漏。`
    };
  }
  return { ok: true, value: result.value };
}
